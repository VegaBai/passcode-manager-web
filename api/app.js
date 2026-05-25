const crypto = require('crypto');

const ROUND_MINUTES = 45;
const STORE_KEY = 'passcode-manager-web:v1';
const PT_TIME_ZONE = 'America/Los_Angeles';
const ALNUM = /^[A-Za-z0-9]+$/;
const TURSO_STATE_TABLE = 'app_state';
const SUPER_ADMIN_EMAILS = new Set(['vegabaixuan@gmail.com']);

let tursoClient = null;
let tursoSchemaPromise = null;

const memoryStore = {
  groups: [],
  credentials: [],
  queueEntries: [],
  operationLogs: [],
  users: [],
  sessions: [],
  playHistory: [],
  adminEmails: []
};

const ptDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ok(res, data = {}) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, data }));
}

function fail(res, message, statusCode = 400) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, message }));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMinutes(value, minutes) {
  const date = toDate(value) || new Date();
  return new Date(date.getTime() + minutes * 60000).toISOString();
}

function ptDateKey(value) {
  const date = toDate(value);
  if (!date) return '';
  const parts = ptDateFormatter.formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isBeforeTodayPT(value, todayKey) {
  const key = ptDateKey(value);
  return Boolean(key && key < todayKey);
}

function parseRemainingMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.min(45, Math.floor(minutes)));
}

function parseAheadGroups(value) {
  const groups = Number(value);
  if (!Number.isFinite(groups)) return 0;
  return Math.max(0, Math.min(20, Math.floor(groups)));
}

function externalCredentialCount(entry) {
  const count = Number(entry.externalCredentialCount || 0);
  if (entry.isExternal && !(entry.credentialIds || []).length && !count) return 2;
  return Math.max(0, Math.min(4, Math.floor(count)));
}

function participantCount(entry) {
  return (entry.credentialIds || []).length + externalCredentialCount(entry);
}

function sortByDateAsc(a, b, field = 'createdAt') {
  return new Date(a[field] || 0).getTime() - new Date(b[field] || 0).getTime();
}

function normalizeState(state) {
  return {
    groups: Array.isArray(state.groups) ? state.groups : [],
    credentials: Array.isArray(state.credentials) ? state.credentials : [],
    queueEntries: Array.isArray(state.queueEntries) ? state.queueEntries : [],
    operationLogs: Array.isArray(state.operationLogs) ? state.operationLogs : [],
    users: Array.isArray(state.users) ? state.users : [],
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    playHistory: Array.isArray(state.playHistory) ? state.playHistory : [],
    adminEmails: normalizeAdminEmails(state.adminEmails)
  };
}

function getTursoClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) return null;

  if (!tursoClient) {
    let createClient;
    try {
      ({ createClient } = require('@libsql/client'));
    } catch (error) {
      throw new Error('缺少 @libsql/client 依赖，请先运行 npm install');
    }
    tursoClient = createClient({
      url,
      authToken
    });
  }

  return tursoClient;
}

async function ensureTursoSchema(client) {
  if (!tursoSchemaPromise) {
    tursoSchemaPromise = client.execute(`
      CREATE TABLE IF NOT EXISTS ${TURSO_STATE_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }
  await tursoSchemaPromise;
}

function storageMode() {
  return process.env.TURSO_DATABASE_URL ? 'turso' : 'memory';
}

async function loadState() {
  const client = getTursoClient();
  if (!client) return clone(memoryStore);

  await ensureTursoSchema(client);
  const result = await client.execute({
    sql: `SELECT value FROM ${TURSO_STATE_TABLE} WHERE key = ? LIMIT 1`,
    args: [STORE_KEY]
  });
  const stored = result.rows && result.rows[0] ? result.rows[0].value : null;
  if (!stored) return clone(memoryStore);
  return normalizeState(typeof stored === 'string' ? JSON.parse(stored) : stored);
}

async function saveState(state) {
  const normalized = normalizeState(state);
  const client = getTursoClient();
  if (!client) {
    Object.assign(memoryStore, clone(normalized));
    return;
  }

  await ensureTursoSchema(client);
  await client.execute({
    sql: `
      INSERT INTO ${TURSO_STATE_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    args: [STORE_KEY, JSON.stringify(normalized), nowIso()]
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeAdminEmails(emails) {
  return Array.from(new Set((Array.isArray(emails) ? emails : [])
    .map(normalizeEmail)
    .filter(Boolean)
    .filter((email) => !SUPER_ADMIN_EMAILS.has(email))))
    .sort();
}

function isSuperAdmin(user) {
  return SUPER_ADMIN_EMAILS.has(normalizeEmail(user?.email));
}

function isRegularAdmin(state, user) {
  return normalizeAdminEmails(state.adminEmails).includes(normalizeEmail(user?.email));
}

function isAccountAdmin(state, user) {
  return isSuperAdmin(user) || isRegularAdmin(state, user);
}

function publicUser(user, state) {
  if (!user) return null;
  const superAdmin = isSuperAdmin(user);
  return {
    _id: user._id,
    email: user.email,
    displayName: user.displayName || '',
    name: user.name || '',
    isSuperAdmin: superAdmin,
    isAdmin: isAccountAdmin(state, user),
    adminEmails: superAdmin ? normalizeAdminEmails(state.adminEmails) : []
  };
}

function actorId(context) {
  return context.user ? context.user._id : context.memberId;
}

function actorDisplayName(context) {
  if (context.user) return context.user.displayName || context.user.name || context.user.email;
  return '未登录用户';
}

function touchUserGroup(user, groupId) {
  if (!user || !groupId) return;
  user.groupIds = Array.from(new Set([...(user.groupIds || []), groupId]));
  user.updatedAt = nowIso();
}

function listGroups(state, context) {
  const id = actorId(context);
  return state.groups
    .filter((group) => (group.memberIds || []).includes(id) || (context.user && (context.user.groupIds || []).includes(group._id)))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function getDoc(state, collectionName, id) {
  return state[collectionName].find((item) => item._id === id) || null;
}

function enterGroup(state, groupId, context) {
  if (!groupId) throw new Error('缺少球群 ID');
  const group = getDoc(state, 'groups', groupId);
  if (!group) throw new Error('球群不存在');
  const id = actorId(context);
  group.memberIds = Array.from(new Set([...(group.memberIds || []), id]));
  group.updatedAt = nowIso();
  touchUserGroup(context.user, groupId);
  return group;
}

function requireLoggedIn(context) {
  if (!context.user) throw new Error('请先登录');
}

function requireSuperAdmin(context) {
  requireLoggedIn(context);
  if (!isSuperAdmin(context.user)) throw new Error('只有总管理员可以管理管理员');
}

function logOperation(state, context, groupId, action, detail) {
  state.operationLogs.push({
    _id: uid('log'),
    groupId,
    operatorMemberId: actorId(context),
    operatorUserId: context.user ? context.user._id : '',
    action,
    detail,
    createdAt: nowIso()
  });
  if (state.operationLogs.length > 800) {
    state.operationLogs = state.operationLogs.slice(-800);
  }
}

function clearExpiredDailyData(state, now = new Date()) {
  const todayKey = ptDateKey(now);
  let clearedCredentials = 0;
  let clearedQueueEntries = 0;

  state.credentials.forEach((item) => {
    if (!item.deletedAt && isBeforeTodayPT(item.createdAt || item.updatedAt, todayKey)) {
      Object.assign(item, {
        status: 'idle',
        currentCourtName: '',
        currentQueueEntryId: '',
        availableAt: now.toISOString(),
        deletedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      clearedCredentials += 1;
    }
  });

  state.queueEntries.forEach((entry) => {
    if (['playing', 'queued'].includes(entry.status) && isBeforeTodayPT(entry.createdAt || entry.startAt || entry.updatedAt, todayKey)) {
      Object.assign(entry, {
        status: 'cleared',
        clearedAt: now.toISOString(),
        updatedAt: now.toISOString()
      });
      clearedQueueEntries += 1;
    }
  });

  return { clearedCredentials, clearedQueueEntries };
}

function finishEntry(state, entry, endedAt) {
  Object.assign(entry, {
    status: 'finished',
    actualEndAt: endedAt.toISOString(),
    updatedAt: endedAt.toISOString()
  });

  (entry.credentialIds || []).forEach((id) => {
    const credential = getDoc(state, 'credentials', id);
    if (!credential) return;
    Object.assign(credential, {
      status: 'idle',
      currentCourtName: '',
      currentQueueEntryId: '',
      availableAt: endedAt.toISOString(),
      updatedAt: endedAt.toISOString()
    });
  });
}

function setEntryPlaying(state, entry, startAt) {
  const endAt = addMinutes(startAt, ROUND_MINUTES);
  Object.assign(entry, {
    status: 'playing',
    groupNo: 0,
    startAt: startAt.toISOString(),
    endAt,
    updatedAt: startAt.toISOString()
  });

  (entry.credentialIds || []).forEach((id) => {
    const credential = getDoc(state, 'credentials', id);
    if (!credential) return;
    Object.assign(credential, {
      status: 'playing',
      currentCourtName: entry.courtName,
      currentQueueEntryId: entry._id,
      availableAt: endAt,
      updatedAt: startAt.toISOString()
    });
  });
}

function rescheduleCourt(state, groupId, courtName) {
  const now = new Date();
  const active = state.queueEntries
    .filter((entry) => entry.groupId === groupId && entry.courtName === courtName && ['playing', 'queued'].includes(entry.status))
    .sort((a, b) => sortByDateAsc(a, b));

  let playing = active.find((entry) => {
    return entry.status === 'playing' && (!entry.endAt || new Date(entry.endAt).getTime() > now.getTime());
  }) || null;

  const queued = active.filter((entry) => entry.status === 'queued');

  if (!playing && queued.length) {
    playing = queued.shift();
    setEntryPlaying(state, playing, now);
  }

  let cursor = playing ? new Date(playing.endAt) : now;
  let groupNo = playing ? 1 : 0;

  queued.forEach((entry) => {
    const startAt = cursor.toISOString();
    const endAt = addMinutes(startAt, ROUND_MINUTES);
    Object.assign(entry, {
      groupNo,
      startAt,
      endAt,
      updatedAt: now.toISOString()
    });

    (entry.credentialIds || []).forEach((id) => {
      const credential = getDoc(state, 'credentials', id);
      if (!credential) return;
      Object.assign(credential, {
        currentCourtName: courtName,
        currentQueueEntryId: entry._id,
        availableAt: endAt,
        updatedAt: now.toISOString()
      });
    });

    cursor = new Date(endAt);
    groupNo += 1;
  });
}

function advanceExpired(state) {
  const now = new Date();
  const dailyCleanup = clearExpiredDailyData(state, now);
  const touchedCourts = new Set();
  let advanced = 0;

  state.queueEntries.forEach((entry) => {
    if (entry.status !== 'playing') return;
    if (!entry.endAt || new Date(entry.endAt).getTime() > now.getTime()) return;
    finishEntry(state, entry, now);
    touchedCourts.add(`${entry.groupId}::${entry.courtName}`);
    advanced += 1;
  });

  touchedCourts.forEach((key) => {
    const [groupId, courtName] = key.split('::');
    rescheduleCourt(state, groupId, courtName);
  });

  return { advanced, ...dailyCleanup };
}

function config() {
  return {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    storage: storageMode()
  };
}

async function verifyGoogleIdToken(idToken) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) throw new Error('服务器尚未配置 GOOGLE_CLIENT_ID');
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error('Google 登录验证失败');
  const data = await response.json();
  if (data.aud !== googleClientId) throw new Error('Google Client ID 不匹配');
  if (!data.email) throw new Error('Google 账号缺少邮箱');
  return data;
}

async function loginGoogle(state, context, payload) {
  const profile = await verifyGoogleIdToken(String(payload.idToken || ''));
  const now = nowIso();
  let user = state.users.find((item) => item.googleSub === profile.sub || item.email === profile.email);
  if (!user) {
    user = {
      _id: uid('usr'),
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name || profile.email,
      displayName: profile.name || profile.email.split('@')[0],
      groupIds: [],
      createdAt: now,
      updatedAt: now
    };
    state.users.push(user);
  } else {
    user.googleSub = profile.sub;
    user.email = profile.email;
    user.name = profile.name || user.name || profile.email;
    user.updatedAt = now;
  }

  const token = sessionToken();
  state.sessions.push({
    token,
    userId: user._id,
    createdAt: now,
    lastSeenAt: now
  });
  if (state.sessions.length > 1000) state.sessions = state.sessions.slice(-1000);

  return { sessionToken: token, user: publicUser(user, state), groups: listGroups(state, { ...context, user }) };
}

function logout(state, context) {
  if (!context.sessionToken) return {};
  state.sessions = state.sessions.filter((session) => session.token !== context.sessionToken);
  return {};
}

function updateProfile(state, context, payload) {
  requireLoggedIn(context);
  const displayName = String(payload.displayName || '').trim();
  if (!displayName) throw new Error('请输入 display name');
  if (displayName.length > 32) throw new Error('display name 不能超过 32 个字符');
  context.user.displayName = displayName;
  context.user.updatedAt = nowIso();
  return { user: publicUser(context.user, state) };
}

function addAdminEmail(state, context, payload) {
  requireSuperAdmin(context);
  const email = normalizeEmail(payload.email);
  if (!email || !email.includes('@')) throw new Error('请输入有效邮箱');
  if (SUPER_ADMIN_EMAILS.has(email)) throw new Error('总管理员不需要重复添加');

  state.adminEmails = normalizeAdminEmails([...(state.adminEmails || []), email]);
  logOperation(state, context, '', 'addAdminEmail', { email });
  return { user: publicUser(context.user, state) };
}

function removeAdminEmail(state, context, payload) {
  requireSuperAdmin(context);
  const email = normalizeEmail(payload.email);
  if (!email) throw new Error('缺少管理员邮箱');

  state.adminEmails = normalizeAdminEmails(state.adminEmails).filter((item) => item !== email);
  logOperation(state, context, '', 'removeAdminEmail', { email });
  return { user: publicUser(context.user, state) };
}

function myHistory(state, context) {
  requireLoggedIn(context);
  return {
    user: publicUser(context.user, state),
    groups: listGroups(state, context),
    history: state.playHistory.filter((item) => item.userId === context.user._id)
  };
}

function init(state, context) {
  advanceExpired(state);
  return {
    memberId: context.memberId,
    user: publicUser(context.user, state),
    groups: listGroups(state, context),
    storage: storageMode()
  };
}

function createGroup(state, context, payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('请输入球群名称');
  const id = actorId(context);

  const group = {
    _id: uid('grp'),
    name,
    ownerMemberId: id,
    ownerUserId: context.user ? context.user._id : '',
    memberIds: [id],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.groups.push(group);
  touchUserGroup(context.user, group._id);
  logOperation(state, context, group._id, 'createGroup', { name });
  return { groupId: group._id, groups: listGroups(state, context) };
}

function joinGroup(state, context, payload) {
  const groupId = String(payload.groupId || '').trim();
  enterGroup(state, groupId, context);
  logOperation(state, context, groupId, 'joinGroup', {});
  return { groupId, groups: listGroups(state, context) };
}

function getDashboard(state, context, payload) {
  const group = enterGroup(state, payload.groupId, context);
  advanceExpired(state);
  return {
    currentGroup: group,
    user: publicUser(context.user, state),
    groups: listGroups(state, context),
    credentials: state.credentials
      .filter((item) => item.groupId === payload.groupId && !item.deletedAt)
      .map((item) => ({
        ...item,
        ownerDisplayName: credentialOwnerName(state, item)
      }))
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()),
    queueEntries: state.queueEntries
      .filter((entry) => entry.groupId === payload.groupId && ['playing', 'queued'].includes(entry.status))
      .sort((a, b) => sortByDateAsc(a, b)),
    now: nowIso()
  };
}

function credentialOwnerName(state, credential) {
  if (credential.createdByUserId) {
    const user = getDoc(state, 'users', credential.createdByUserId);
    return (user && (user.displayName || user.name || user.email)) || credential.createdByDisplayName || '登录用户';
  }
  return credential.createdByDisplayName || '未登录用户';
}

function addCredential(state, context, payload) {
  const groupId = payload.groupId;
  enterGroup(state, groupId, context);

  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();
  if (!ALNUM.test(username) || !ALNUM.test(password)) {
    throw new Error('用户名和密码只能包含英文或数字');
  }

  const duplicate = state.credentials.find((item) => item.groupId === groupId && item.username === username && !item.deletedAt);
  if (duplicate) throw new Error('这个用户名已经存在');

  const credential = {
    _id: uid('cred'),
    groupId,
    username,
    password,
    status: 'idle',
    currentCourtName: '',
    currentQueueEntryId: '',
    createdByMemberId: actorId(context),
    createdByUserId: context.user ? context.user._id : '',
    createdByDisplayName: actorDisplayName(context),
    createdByAuthenticated: Boolean(context.user),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  state.credentials.push(credential);
  logOperation(state, context, groupId, 'addCredential', { credentialId: credential._id, username });
  return { credentialId: credential._id };
}

function updateCredential(state, context, payload) {
  requireLoggedIn(context);
  const groupId = payload.groupId;
  enterGroup(state, groupId, context);
  const credential = getDoc(state, 'credentials', payload.credentialId);
  if (!credential || credential.groupId !== groupId || credential.deletedAt) throw new Error('账号不存在');
  if (credential.createdByUserId !== context.user._id) throw new Error('只能修改自己登录后添加的账号');
  if (credential.status !== 'idle') throw new Error('排队或正在打的账号不能修改');

  const username = String(payload.username || '').trim();
  const password = String(payload.password || '').trim();
  if (!ALNUM.test(username) || !ALNUM.test(password)) throw new Error('用户名和密码只能包含英文或数字');
  const duplicate = state.credentials.find((item) => item.groupId === groupId && item.username === username && item._id !== credential._id && !item.deletedAt);
  if (duplicate) throw new Error('这个用户名已经存在');

  credential.username = username;
  credential.password = password;
  credential.updatedAt = nowIso();
  logOperation(state, context, groupId, 'updateCredential', { credentialId: credential._id, username });
  return {};
}

function deleteCredential(state, context, payload) {
  requireLoggedIn(context);
  const groupId = payload.groupId;
  enterGroup(state, groupId, context);
  const credential = getDoc(state, 'credentials', payload.credentialId);
  if (!credential || credential.groupId !== groupId || credential.deletedAt) throw new Error('账号不存在');
  if (credential.createdByUserId !== context.user._id && !isAccountAdmin(state, context.user)) throw new Error('只能删除自己登录后添加的账号');
  if (credential.status !== 'idle') throw new Error('排队或正在打的账号不能删除');

  credential.deletedAt = nowIso();
  credential.updatedAt = nowIso();
  logOperation(state, context, groupId, 'deleteCredential', { credentialId: credential._id });
  return {};
}

function addExternalEntry(state, context, groupId, courtName, status, groupNo, startAt, createdAtCursor) {
  const entry = {
    _id: uid('queue'),
    groupId,
    courtName,
    credentialIds: [],
    credentialBatches: [],
    status,
    groupNo,
    isExternal: true,
    externalCredentialCount: 2,
    createdByMemberId: actorId(context),
    createdByUserId: context.user ? context.user._id : '',
    startAt: startAt.toISOString(),
    endAt: addMinutes(startAt, ROUND_MINUTES),
    createdAt: new Date(createdAtCursor).toISOString(),
    updatedAt: nowIso()
  };
  state.queueEntries.push(entry);
  return entry;
}

function recordPlayHistory(state, context, groupId, queueEntryId, credentials) {
  if (!context.user) return;
  const owned = credentials.filter((credential) => credential.createdByUserId === context.user._id);
  if (!owned.length) return;
  const dateKey = ptDateKey(new Date());
  owned.forEach((credential) => {
    const exists = state.playHistory.some((item) => item.userId === context.user._id && item.queueEntryId === queueEntryId && item.credentialId === credential._id);
    if (exists) return;
    state.playHistory.push({
      _id: uid('hist'),
      userId: context.user._id,
      groupId,
      queueEntryId,
      credentialId: credential._id,
      dateKey,
      playedAt: nowIso()
    });
  });
  if (state.playHistory.length > 5000) state.playHistory = state.playHistory.slice(-5000);
}

function addQueueEntry(state, context, payload) {
  const groupId = payload.groupId;
  enterGroup(state, groupId, context);

  const courtName = String(payload.courtName || '').trim();
  const courtRemainingMinutes = parseRemainingMinutes(payload.courtRemainingMinutes);
  const courtAheadGroups = parseAheadGroups(payload.courtAheadGroups);
  const targetQueueEntryId = String(payload.targetQueueEntryId || '').trim();
  const credentialIds = Array.isArray(payload.credentialIds) ? payload.credentialIds : [];

  if (!courtName) throw new Error('请输入场地编号');
  if (targetQueueEntryId && credentialIds.length !== 2) throw new Error('补全半场必须选择 2 个账号');
  if (!targetQueueEntryId && !(credentialIds.length === 2 || credentialIds.length === 4)) throw new Error('每组必须选择 2 个或 4 个账号');
  if (new Set(credentialIds).size !== credentialIds.length) throw new Error('不能重复选择账号');

  advanceExpired(state);

  const credentials = credentialIds.map((id) => getDoc(state, 'credentials', id));
  if (credentials.some((item) => !item || item.groupId !== groupId || item.deletedAt)) throw new Error('账号数据不完整');
  const blocked = credentials.find((item) => item.status !== 'idle');
  if (blocked) throw new Error(`${blocked.username} 不是空闲状态`);

  if (targetQueueEntryId) {
    const targetEntry = getDoc(state, 'queueEntries', targetQueueEntryId);
    if (!targetEntry || targetEntry.groupId !== groupId || targetEntry.courtName !== courtName) throw new Error('要补全的半场不存在');
    if (!['playing', 'queued'].includes(targetEntry.status)) throw new Error('只能补全正在打或排队中的半场');
    const targetExternalCount = externalCredentialCount(targetEntry);
    if (participantCount(targetEntry) !== 2) throw new Error('这组已经不是半场');

    const mergedCredentialIds = [...(targetEntry.credentialIds || []), ...credentialIds];
    if (new Set(mergedCredentialIds).size !== mergedCredentialIds.length) throw new Error('账号已经在这组里');

    const existingBatches = Array.isArray(targetEntry.credentialBatches) && targetEntry.credentialBatches.length
      ? targetEntry.credentialBatches
      : [targetEntry.credentialIds || []];
    targetEntry.credentialIds = mergedCredentialIds;
    targetEntry.credentialBatches = existingBatches.filter((batch) => (batch || []).length).concat([credentialIds]);
    targetEntry.externalCredentialCount = targetExternalCount;
    targetEntry.updatedAt = nowIso();

    credentials.forEach((credential) => {
      Object.assign(credential, {
        status: targetEntry.status,
        currentCourtName: courtName,
        currentQueueEntryId: targetEntry._id,
        availableAt: targetEntry.endAt,
        updatedAt: nowIso()
      });
    });

    recordPlayHistory(state, context, groupId, targetEntry._id, credentials);
    logOperation(state, context, groupId, 'completeHalfCourt', { queueEntryId: targetEntry._id, courtName, credentialIds });
    return { queueEntryId: targetEntry._id };
  }

  const now = new Date();
  const activeEntries = state.queueEntries
    .filter((entry) => entry.groupId === groupId && entry.courtName === courtName && ['playing', 'queued'].includes(entry.status))
    .sort((a, b) => sortByDateAsc(a, b));
  const hadTrackedCourt = activeEntries.length > 0;
  let createdAtCursor = now.getTime();

  if (!hadTrackedCourt && courtRemainingMinutes > 0) {
    const externalEndAt = new Date(now.getTime() + courtRemainingMinutes * 60000);
    const external = {
      _id: uid('queue'),
      groupId,
      courtName,
      credentialIds: [],
      credentialBatches: [],
      status: 'playing',
      groupNo: 0,
      isExternal: true,
      externalCredentialCount: 2,
      createdByMemberId: actorId(context),
      createdByUserId: context.user ? context.user._id : '',
      startAt: now.toISOString(),
      endAt: externalEndAt.toISOString(),
      createdAt: new Date(createdAtCursor).toISOString(),
      updatedAt: now.toISOString()
    };
    state.queueEntries.push(external);
    activeEntries.push(external);
    createdAtCursor += 1;
  }

  if (!hadTrackedCourt && courtAheadGroups > 0) {
    let cursor = activeEntries.reduce((latest, entry) => {
      const endAt = toDate(entry.endAt) || now;
      return endAt.getTime() > latest.getTime() ? endAt : latest;
    }, now);

    for (let index = 0; index < courtAheadGroups; index += 1) {
      const external = addExternalEntry(state, context, groupId, courtName, 'queued', activeEntries.length, cursor, createdAtCursor);
      activeEntries.push(external);
      cursor = new Date(external.endAt);
      createdAtCursor += 1;
    }
  }

  const hasPlaying = activeEntries.some((entry) => entry.status === 'playing');
  const status = hasPlaying || activeEntries.length ? 'queued' : 'playing';
  const latestEnd = activeEntries.reduce((latest, entry) => {
    const endAt = toDate(entry.endAt) || now;
    return endAt.getTime() > latest.getTime() ? endAt : latest;
  }, now);
  const startAt = status === 'playing' ? now.toISOString() : latestEnd.toISOString();
  const endAt = addMinutes(startAt, ROUND_MINUTES);
  const entry = {
    _id: uid('queue'),
    groupId,
    courtName,
    credentialIds,
    credentialBatches: credentialIds.length ? [credentialIds] : [],
    status,
    groupNo: status === 'playing' ? 0 : activeEntries.length,
    createdByMemberId: actorId(context),
    createdByUserId: context.user ? context.user._id : '',
    startAt,
    endAt,
    createdAt: new Date(createdAtCursor).toISOString(),
    updatedAt: now.toISOString()
  };
  state.queueEntries.push(entry);

  credentials.forEach((credential) => {
    Object.assign(credential, {
      status,
      currentCourtName: courtName,
      currentQueueEntryId: entry._id,
      availableAt: endAt,
      updatedAt: now.toISOString()
    });
  });

  rescheduleCourt(state, groupId, courtName);
  recordPlayHistory(state, context, groupId, entry._id, credentials);
  logOperation(state, context, groupId, 'addQueueEntry', { queueEntryId: entry._id, courtName, credentialIds });
  return { queueEntryId: entry._id };
}

function cancelQueueEntry(state, context, payload) {
  const groupId = payload.groupId;
  enterGroup(state, groupId, context);
  const entry = getDoc(state, 'queueEntries', payload.queueEntryId);
  const requestedCancelCredentialIds = Array.isArray(payload.cancelCredentialIds) ? payload.cancelCredentialIds : [];
  if (!entry || entry.groupId !== groupId) throw new Error('排队记录不存在');
  if (!['playing', 'queued'].includes(entry.status)) throw new Error('这条记录已经结束');

  const existingCredentialIds = entry.credentialIds || [];
  const cancelCredentialIds = requestedCancelCredentialIds.length ? requestedCancelCredentialIds : existingCredentialIds;
  const existingExternalCount = externalCredentialCount(entry);
  if (!(cancelCredentialIds.length === 2 || cancelCredentialIds.length === 4)) throw new Error('必须取消 2 个或 4 个账号');
  if (new Set(cancelCredentialIds).size !== cancelCredentialIds.length) throw new Error('不能重复选择账号');
  if (cancelCredentialIds.some((id) => !existingCredentialIds.includes(id))) throw new Error('只能取消这一组里的账号');
  const cancelCredentials = cancelCredentialIds.map((id) => getDoc(state, 'credentials', id));
  if (cancelCredentials.some((credential) => !credential)) throw new Error('账号数据不完整');

  const remainingCredentialIds = existingCredentialIds.filter((id) => !cancelCredentialIds.includes(id));
  if (remainingCredentialIds.length) {
    if (remainingCredentialIds.length !== 2) throw new Error('取消后必须保留 2 个账号或取消整组');
    const batches = Array.isArray(entry.credentialBatches) && entry.credentialBatches.length ? entry.credentialBatches : [existingCredentialIds];
    entry.credentialIds = remainingCredentialIds;
    entry.credentialBatches = batches.map((batch) => (batch || []).filter((id) => !cancelCredentialIds.includes(id))).filter((batch) => batch.length);
    entry.updatedAt = nowIso();
  } else if (existingExternalCount > 0) {
    entry.credentialIds = [];
    entry.credentialBatches = [];
    entry.externalCredentialCount = existingExternalCount;
    entry.updatedAt = nowIso();
  } else {
    Object.assign(entry, {
      status: 'cancelled',
      cancelledByMemberId: actorId(context),
      cancelledByUserId: context.user ? context.user._id : '',
      cancelledAt: nowIso(),
      updatedAt: nowIso()
    });
  }

  cancelCredentialIds.forEach((id) => {
    const credential = getDoc(state, 'credentials', id);
    if (!credential) return;
    Object.assign(credential, {
      status: 'idle',
      currentCourtName: '',
      currentQueueEntryId: '',
      availableAt: nowIso(),
      updatedAt: nowIso()
    });
  });

  rescheduleCourt(state, groupId, entry.courtName);
  logOperation(state, context, groupId, 'cancelQueueEntry', { queueEntryId: entry._id, courtName: entry.courtName, credentialIds: cancelCredentialIds });
  return {};
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function buildContext(state, memberId, token) {
  const session = token ? state.sessions.find((item) => item.token === token) : null;
  const user = session ? getDoc(state, 'users', session.userId) : null;
  if (session) session.lastSeenAt = nowIso();
  return {
    memberId,
    sessionToken: token || '',
    user: user || null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === 'GET') {
    ok(res, { status: 'ready' });
    return;
  }

  if (req.method !== 'POST') {
    fail(res, '只支持 POST 请求', 405);
    return;
  }

  try {
    const body = await readBody(req);
    const action = body.action;
    const payload = body.payload || {};
    const memberId = String(body.memberId || payload.memberId || '').trim();
    if (!memberId) throw new Error('缺少用户标识，请刷新页面重试');

    const state = await loadState();
    const context = buildContext(state, memberId, String(body.sessionToken || payload.sessionToken || '').trim());
    const actions = {
      config,
      loginGoogle,
      logout,
      updateProfile,
      addAdminEmail,
      removeAdminEmail,
      myHistory,
      init,
      createGroup,
      joinGroup,
      getDashboard,
      addCredential,
      updateCredential,
      deleteCredential,
      addQueueEntry,
      cancelQueueEntry,
      advanceExpired: (currentState) => advanceExpired(currentState)
    };

    if (!actions[action]) throw new Error('未知操作');
    const data = await actions[action](state, context, payload);
    await saveState(state);
    ok(res, data);
  } catch (error) {
    fail(res, error.message || '操作失败');
  }
};
