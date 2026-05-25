const ALNUM = /^[A-Za-z0-9]+$/;
const API_URL = '/api/app';

const app = document.getElementById('app');
const toast = document.getElementById('toast');

const state = {
  loading: false,
  savingQueue: false,
  memberId: ensureMemberId(),
  sessionToken: localStorage.getItem('passcode-manager-web-session') || '',
  googleClientId: '',
  user: null,
  storage: '',
  groups: [],
  currentGroup: null,
  credentials: [],
  queueEntries: [],
  selectedIds: new Set(),
  cancelSelectedIds: new Set(),
  modal: '',
  joinGroupId: new URLSearchParams(location.search).get('group') || '',
  sortMode: localStorage.getItem('credentialSortMode') || 'default',
  queueOpen: false,
  form: {
    groupName: 'Fremont Bintang',
    displayName: '',
    adminEmail: '',
    editUsername: '',
    editPassword: '',
    username: '',
    password: '',
    courtName: '',
    courtRemainingMinutes: '',
    courtAheadGroups: '',
    targetQueueEntryId: ''
  },
  history: [],
  editingCredentialId: '',
  cancelEntryId: '',
  nowTs: Date.now()
};

function ensureMemberId() {
  const key = 'passcode-manager-web-member-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(key, created);
  return created;
}

function html(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

function formatClock(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPTDateTime(value) {
  const date = toDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function minutesUntil(value, nowTs = state.nowTs) {
  const date = toDate(value);
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - nowTs) / 60000));
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

function participantCount(entry) {
  const credentialCount = (entry.credentialIds || []).length;
  const externalCount = Number(entry.externalCredentialCount || 0);
  if (entry.isExternal && !credentialCount && !externalCount) return 2;
  return credentialCount + externalCount;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function callApi(action, payload = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, memberId: state.memberId, sessionToken: state.sessionToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.message || '操作失败');
  return result.data || {};
}

function normalizeGroups(groups) {
  return (groups || []).map((group) => ({
    ...group,
    displayName: group.name || '羽毛球群',
    shortId: group._id ? group._id.slice(-8) : ''
  }));
}

function pickCurrentGroup(groupId) {
  const targetId = groupId || localStorage.getItem('currentGroupId');
  let group = state.groups.find((item) => item._id === targetId);
  if (!group && state.groups.length) group = state.groups[0];
  state.currentGroup = group || null;
  if (state.currentGroup) {
    localStorage.setItem('currentGroupId', state.currentGroup._id);
    const nextUrl = `${location.pathname}?group=${encodeURIComponent(state.currentGroup._id)}`;
    if (`${location.pathname}${location.search}` !== nextUrl) history.replaceState({}, '', nextUrl);
  }
}

async function init() {
  setLoading(true);
  try {
    const cfg = await callApi('config');
    state.googleClientId = cfg.googleClientId || '';
    const result = await callApi('init');
    state.storage = result.storage || '';
    state.user = result.user || null;
    state.form.displayName = state.user?.displayName || '';
    state.groups = normalizeGroups(result.groups || []);
    if (state.joinGroupId) {
      await joinGroup(state.joinGroupId, false);
      return;
    }
    pickCurrentGroup();
    if (state.currentGroup) await refreshDashboard(false);
  } catch (error) {
    showToast(error.message);
  } finally {
    setLoading(false);
    render();
  }
}

function setLoading(loading) {
  state.loading = loading;
  render();
}

async function refreshDashboard(withToast = true) {
  if (!state.currentGroup) {
    state.credentials = [];
    state.queueEntries = [];
    render();
    return;
  }

  state.loading = true;
  render();
  try {
    const result = await callApi('getDashboard', { groupId: state.currentGroup._id });
    state.user = result.user || state.user;
    state.form.displayName = state.user?.displayName || state.form.displayName;
    state.groups = normalizeGroups(result.groups || state.groups);
    state.currentGroup = result.currentGroup ? normalizeGroups([result.currentGroup])[0] : state.currentGroup;
    state.credentials = result.credentials || [];
    state.queueEntries = result.queueEntries || [];
    state.nowTs = result.now ? new Date(result.now).getTime() : Date.now();
    pickCurrentGroup(state.currentGroup._id);
    if (withToast) showToast('已刷新');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.loading = false;
    render();
  }
}

async function createGroup() {
  const name = state.form.groupName.trim();
  if (!name) {
    showToast('请输入球群名称');
    return;
  }
  try {
    const result = await callApi('createGroup', { name });
    state.groups = normalizeGroups(result.groups || []);
    pickCurrentGroup(result.groupId);
    state.form.groupName = 'Fremont Bintang';
    state.modal = '';
    await refreshDashboard(false);
    showToast('球群已创建');
  } catch (error) {
    showToast(error.message);
  }
}

async function joinGroup(groupId = state.joinGroupId, showJoinedToast = true) {
  const target = String(groupId || '').trim();
  if (!target) return;
  try {
    const result = await callApi('joinGroup', { groupId: target });
    state.groups = normalizeGroups(result.groups || []);
    pickCurrentGroup(result.groupId);
    state.joinGroupId = '';
    history.replaceState({}, '', `${location.pathname}?group=${encodeURIComponent(result.groupId)}`);
    await refreshDashboard(false);
    if (showJoinedToast) showToast('已加入球群');
  } catch (error) {
    showToast(error.message);
  }
}

async function addCredential() {
  const username = state.form.username.trim();
  const password = state.form.password.trim();
  if (!state.currentGroup) return;
  if (!ALNUM.test(username) || !ALNUM.test(password)) {
    showToast('用户名和密码只能包含英文或数字');
    return;
  }
  try {
    await callApi('addCredential', { groupId: state.currentGroup._id, username, password });
    state.form.username = '';
    state.form.password = '';
    await refreshDashboard(false);
    showToast('账号已添加');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteCredential(id) {
  if (!state.currentGroup) return;
  if (!confirm('确定删除这个用户名和密码吗？')) return;
  try {
    await callApi('deleteCredential', { groupId: state.currentGroup._id, credentialId: id });
    await refreshDashboard(false);
    showToast('账号已删除');
  } catch (error) {
    showToast(error.message);
  }
}

async function updateCredential() {
  if (!state.currentGroup || !state.editingCredentialId) return;
  const username = state.form.editUsername.trim();
  const password = state.form.editPassword.trim();
  if (!ALNUM.test(username) || !ALNUM.test(password)) {
    showToast('用户名和密码只能包含英文或数字');
    return;
  }
  try {
    await callApi('updateCredential', {
      groupId: state.currentGroup._id,
      credentialId: state.editingCredentialId,
      username,
      password
    });
    state.modal = '';
    state.editingCredentialId = '';
    await refreshDashboard(false);
    showToast('账号已更新');
  } catch (error) {
    showToast(error.message);
  }
}

async function handleGoogleCredential(idToken) {
  try {
    const result = await callApi('loginGoogle', { idToken });
    state.sessionToken = result.sessionToken || '';
    localStorage.setItem('passcode-manager-web-session', state.sessionToken);
    state.user = result.user || null;
    state.form.displayName = state.user?.displayName || '';
    state.groups = normalizeGroups(result.groups || state.groups);
    if (state.currentGroup) await refreshDashboard(false);
    showToast('已登录');
  } catch (error) {
    showToast(error.message);
  } finally {
    render();
  }
}

function loadGoogleButton() {
  if (!state.googleClientId || !state.modal || state.user) return;
  const mount = document.getElementById('google-signin');
  if (!mount) return;
  const renderButton = () => {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({
      client_id: state.googleClientId,
      callback: (response) => handleGoogleCredential(response.credential)
    });
    window.google.accounts.id.renderButton(mount, {
      theme: 'outline',
      size: 'large',
      width: Math.min(320, mount.clientWidth || 280)
    });
  };
  if (window.google?.accounts?.id) {
    renderButton();
    return;
  }
  const existing = document.querySelector('script[data-google-identity]');
  if (existing) {
    existing.addEventListener('load', renderButton, { once: true });
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.dataset.googleIdentity = 'true';
  script.addEventListener('load', renderButton, { once: true });
  document.head.appendChild(script);
}

async function logout() {
  try {
    await callApi('logout');
  } catch (error) {
    showToast(error.message);
  }
  state.sessionToken = '';
  state.user = null;
  state.groups = [];
  state.history = [];
  localStorage.removeItem('passcode-manager-web-session');
  if (state.currentGroup) await refreshDashboard(false);
  state.modal = '';
  render();
}

async function saveProfile() {
  try {
    const result = await callApi('updateProfile', { displayName: state.form.displayName });
    state.user = result.user || state.user;
    showToast('设置已保存');
    await loadMyHistory();
  } catch (error) {
    showToast(error.message);
  }
}

async function addAdminEmail() {
  const email = state.form.adminEmail.trim();
  if (!email) {
    showToast('请输入管理员邮箱');
    return;
  }
  try {
    const result = await callApi('addAdminEmail', { email });
    state.user = result.user || state.user;
    state.form.adminEmail = '';
    showToast('管理员已添加');
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function removeAdminEmail(email) {
  try {
    const result = await callApi('removeAdminEmail', { email });
    state.user = result.user || state.user;
    showToast('管理员已删除');
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function loadMyHistory() {
  if (!state.user) return;
  try {
    const result = await callApi('myHistory');
    state.history = result.history || [];
    state.groups = normalizeGroups(result.groups || state.groups);
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function addQueueEntry() {
  if (!state.currentGroup) return;
  const selectedIds = Array.from(state.selectedIds);
  const courtName = state.form.courtName.trim();
  if (!courtName) {
    showToast('请输入场地编号');
    return;
  }
  if (state.form.targetQueueEntryId && selectedIds.length !== 2) {
    showToast('补全半场请选择 2 个账号');
    return;
  }
  if (!state.form.targetQueueEntryId && !(selectedIds.length === 2 || selectedIds.length === 4)) {
    showToast('请选择 2 个或 4 个账号');
    return;
  }

  state.savingQueue = true;
  render();
  try {
    await callApi('addQueueEntry', {
      groupId: state.currentGroup._id,
      courtName,
      courtRemainingMinutes: parseRemainingMinutes(state.form.courtRemainingMinutes),
      courtAheadGroups: parseAheadGroups(state.form.courtAheadGroups),
      targetQueueEntryId: state.form.targetQueueEntryId,
      credentialIds: selectedIds
    });
    state.selectedIds.clear();
    state.form.courtRemainingMinutes = '';
    state.form.courtAheadGroups = '';
    state.form.targetQueueEntryId = '';
    state.queueOpen = false;
    await refreshDashboard(false);
    showToast('排队已添加');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.savingQueue = false;
    render();
  }
}

async function cancelQueueEntry(entryId, selectedIds = null) {
  if (!state.currentGroup) return;
  const entry = state.queueEntries.find((item) => item._id === entryId);
  if (!entry) return;
  const credentialIds = selectedIds || entry.credentialIds || [];
  if (!credentialIds.length) {
    showToast('这组没有可取消的账号');
    return;
  }
  const confirmed = confirm(`确定取消选中的 ${credentialIds.length} 个账号吗？`);
  if (!confirmed) return;
  try {
    await callApi('cancelQueueEntry', {
      groupId: state.currentGroup._id,
      queueEntryId: entryId,
      cancelCredentialIds: credentialIds
    });
    state.modal = '';
    state.cancelEntryId = '';
    state.cancelSelectedIds.clear();
    await refreshDashboard(false);
    showToast('排队已取消');
  } catch (error) {
    showToast(error.message);
  }
}

function openCancel(entryId) {
  const entry = state.queueEntries.find((item) => item._id === entryId);
  if (!entry) return;
  if ((entry.credentialIds || []).length === 4) {
    state.cancelEntryId = entryId;
    state.cancelSelectedIds.clear();
    state.modal = 'cancel';
    render();
    return;
  }
  cancelQueueEntry(entryId, entry.credentialIds || []);
}

function shareGroup() {
  if (!state.currentGroup) return;
  const url = `${location.origin}${location.pathname}?group=${encodeURIComponent(state.currentGroup._id)}`;
  navigator.clipboard?.writeText(url).then(
    () => showToast('分享链接已复制'),
    () => prompt('复制这个链接分享给队友', url)
  );
}

function buildCredentials() {
  const entriesById = Object.fromEntries(state.queueEntries.map((entry) => [entry._id, entry]));
  const statusText = { idle: '空闲', playing: '正在打', queued: '排队中' };
  const statusRank = { idle: 0, playing: 1, queued: 2 };
  const canAdminDelete = Boolean(state.user?.isAdmin);

  const mapped = state.credentials.map((item) => {
    const entry = item.currentQueueEntryId ? entriesById[item.currentQueueEntryId] : null;
    let timeText = '';
    const isOwner = Boolean(state.user && item.createdByUserId === state.user._id);
    if (item.status === 'playing' && entry) timeText = `剩余 ${minutesUntil(entry.endAt)} 分钟`;
    if (item.status === 'queued' && entry) timeText = `预计 ${formatClock(entry.startAt)} 上场`;
    return {
      ...item,
      statusText: statusText[item.status] || item.status,
      courtName: item.currentCourtName || entry?.courtName || '',
      groupNo: entry?.groupNo,
      hasGroupNo: Boolean(entry) && entry.groupNo !== undefined && entry.groupNo !== null,
      timeText,
      ownerText: item.ownerDisplayName || item.createdByDisplayName || (item.createdByMemberId === state.memberId ? '未登录用户' : '群成员添加'),
      createdAtText: formatPTDateTime(item.createdAt),
      createdAtTs: toDate(item.createdAt)?.getTime() || 0,
      canManage: Boolean(isOwner && item.status === 'idle'),
      canDelete: Boolean((isOwner || canAdminDelete) && item.status === 'idle'),
      canCancelQueue: Boolean(isOwner && (item.status === 'playing' || item.status === 'queued'))
    };
  });

  const defaultCompare = (a, b) => {
    const rankDelta = (statusRank[a.status] || 9) - (statusRank[b.status] || 9);
    if (rankDelta) return rankDelta;
    const courtDelta = String(a.courtName || '').localeCompare(String(b.courtName || ''));
    if (courtDelta) return courtDelta;
    return String(a.username).localeCompare(String(b.username));
  };

  return mapped.sort((a, b) => {
    if (state.sortMode === 'createdAsc') return (a.createdAtTs - b.createdAtTs) || defaultCompare(a, b);
    if (state.sortMode === 'createdDesc') return (b.createdAtTs - a.createdAtTs) || defaultCompare(a, b);
    return defaultCompare(a, b);
  });
}

function buildCourtStats() {
  const playingCourts = {};
  const queuedEntries = [];

  state.queueEntries.forEach((entry) => {
    if (!entry.courtName || !(entry.credentialIds || []).length) return;
    if (entry.status === 'playing') {
      const courtName = String(entry.courtName);
      if (!playingCourts[courtName]) {
        playingCourts[courtName] = { courtName, isHalf: false, minutes: minutesUntil(entry.endAt) };
      }
      if ((entry.credentialIds || []).length === 2) playingCourts[courtName].isHalf = true;
      playingCourts[courtName].minutes = Math.min(playingCourts[courtName].minutes, minutesUntil(entry.endAt));
    }
    if (entry.status === 'queued') queuedEntries.push(entry);
  });

  const playingItems = Object.keys(playingCourts).sort().map((courtName) => playingCourts[courtName]);
  const shownMinuteCourts = new Set();
  const queuedItems = queuedEntries
    .slice()
    .sort((a, b) => (Number(a.groupNo || 0) - Number(b.groupNo || 0)) || String(a.courtName).localeCompare(String(b.courtName)))
    .map((entry) => {
      const courtName = String(entry.courtName);
      const hasMinutes = !shownMinuteCourts.has(courtName);
      shownMinuteCourts.add(courtName);
      return {
        courtName,
        isHalf: (entry.credentialIds || []).length === 2,
        hasMinutes,
        minutes: hasMinutes ? minutesUntil(entry.startAt) : 0,
        key: entry._id
      };
    });

  return { playingItems, queuedItems };
}

function buildHalfGroupOptions() {
  const courtName = state.form.courtName.trim();
  if (!courtName) return [];
  return state.queueEntries
    .filter((entry) => entry.courtName === courtName && ['playing', 'queued'].includes(entry.status) && participantCount(entry) === 2 && Number(entry.groupNo) >= 0)
    .sort((a, b) => Number(a.groupNo) - Number(b.groupNo))
    .map((entry) => ({
      id: entry._id,
      label: entry.isExternal && !(entry.credentialIds || []).length ? `加入第 ${entry.groupNo} 组半场` : `补全第 ${entry.groupNo} 组半场`,
      statusText: entry.status === 'playing' ? '正在打' : '排队中'
    }));
}

function buildCourtPreview() {
  const courtName = state.form.courtName.trim();
  const manualRemaining = parseRemainingMinutes(state.form.courtRemainingMinutes);
  const aheadGroups = parseAheadGroups(state.form.courtAheadGroups);
  if (!courtName) {
    return {
      nextGroupNo: (manualRemaining > 0 ? 1 : 0) + aheadGroups,
      remainingMinutes: manualRemaining,
      waitMinutes: manualRemaining + aheadGroups * 45,
      hasTrackedCourt: false
    };
  }

  const entries = state.queueEntries.filter((entry) => entry.courtName === courtName);
  const playing = entries.find((entry) => entry.status === 'playing');
  const queued = entries.filter((entry) => entry.status === 'queued');
  if (!entries.length) {
    return {
      nextGroupNo: (manualRemaining > 0 ? 1 : 0) + aheadGroups,
      remainingMinutes: manualRemaining,
      waitMinutes: manualRemaining + aheadGroups * 45,
      hasTrackedCourt: false
    };
  }

  const targetEntry = state.form.targetQueueEntryId ? entries.find((entry) => entry._id === state.form.targetQueueEntryId) : null;
  if (targetEntry) {
    return {
      nextGroupNo: Number(targetEntry.groupNo || 0),
      remainingMinutes: targetEntry.status === 'playing' ? minutesUntil(targetEntry.endAt) : 0,
      waitMinutes: targetEntry.status === 'queued' ? minutesUntil(targetEntry.startAt) : 0,
      hasTrackedCourt: true
    };
  }

  const waitUntil = queued.length ? queued[queued.length - 1].endAt : playing?.endAt;
  return {
    nextGroupNo: (playing ? 1 : 0) + queued.length,
    remainingMinutes: playing ? minutesUntil(playing.endAt) : 0,
    waitMinutes: waitUntil ? minutesUntil(waitUntil) : 0,
    hasTrackedCourt: true
  };
}

function renderCourtItems(items, emptyText) {
  if (!items.length) return `<div class="court-line">${emptyText}</div>`;
  return `<div class="court-line"><span>场地号：</span>${items.map((item) => `
    <span class="court-chip">${html(item.courtName)}${item.isHalf ? '<small>半</small>' : ''}${item.hasMinutes !== false ? `<small>（${item.minutes}）</small>` : ''}</span>
  `).join('')}</div>`;
}

function renderQueueInfoContent(courtPreview) {
  return `
    <div>第 ${courtPreview.nextGroupNo} 组</div>
    ${!courtPreview.hasTrackedCourt ? `<div>当前剩余 ${courtPreview.remainingMinutes} 分钟</div>` : ''}
    <div>预计等待 ${courtPreview.waitMinutes} 分钟</div>
  `;
}

function renderQueueInfo(courtPreview) {
  return `<div class="queue-info" data-queue-info>${renderQueueInfoContent(courtPreview)}</div>`;
}

function updateQueueInfo() {
  const queueInfo = app.querySelector('[data-queue-info]');
  if (!queueInfo) return;
  queueInfo.innerHTML = renderQueueInfoContent(buildCourtPreview());
}

function isEditingFormField() {
  const activeElement = document.activeElement;
  return Boolean(activeElement?.matches?.('[data-field]'));
}

function renderJoinBanner() {
  if (!state.joinGroupId || state.groups.some((group) => group._id === state.joinGroupId)) return '';
  return `
    <section class="section join-banner">
      <div class="section-title">加入共享球群</div>
      <div class="group-row">
        <div class="group-name">邀请码 ${html(state.joinGroupId)}</div>
        <button class="btn primary" data-action="join-link">加入</button>
      </div>
    </section>
  `;
}

function renderEmptyState() {
  return `
    <section class="section">
      <h2 class="section-title">创建第一个球群</h2>
      <div class="inline-form">
        <div class="field">
          <label for="first-group-name">球群名称</label>
          <input id="first-group-name" class="input" value="${html(state.form.groupName)}" placeholder="Fremont Bintang" data-field="groupName" />
        </div>
        <button class="btn primary" data-action="create-group">创建</button>
      </div>
    </section>
  `;
}

function renderDashboard() {
  if (!state.currentGroup) return renderEmptyState();
  const credentials = buildCredentials();
  const idleCredentials = credentials.filter((item) => item.status === 'idle');
  const stats = {
    total: credentials.length,
    idle: credentials.filter((item) => item.status === 'idle').length,
    playing: credentials.filter((item) => item.status === 'playing').length,
    queued: credentials.filter((item) => item.status === 'queued').length
  };
  const courtStats = buildCourtStats();
  const courtPreview = buildCourtPreview();
  const halfGroupOptions = buildHalfGroupOptions();

  return `
    <section class="section">
      <div class="group-row">
        <div class="group-label">球群</div>
        <div class="group-name">${html(state.currentGroup.displayName)}</div>
        <div class="invite-code">邀请码 ${html(state.currentGroup.shortId || state.currentGroup._id)}</div>
      </div>
    </section>

    <div class="divider"></div>

    <div class="content-grid">
      <section>
        <button class="btn refresh-above-courts" data-action="refresh">${state.loading ? '刷新中' : '刷新'}</button>
        <h2 class="section-title">
          <span>场地</span>
          <span class="section-hint">手动录入可能与球馆系统有时间误差</span>
        </h2>
        <div class="court-stat playing">
          <div class="court-title">正在打 ${courtStats.playingItems.length} 个场地 <span class="court-hint">场地号（剩余分钟数）</span></div>
          ${renderCourtItems(courtStats.playingItems, '场地号：无')}
        </div>
        <div class="court-stat">
          <div class="court-title">排队中 ${courtStats.queuedItems.length} 个场地 <span class="court-hint">场地号（等待分钟数）</span></div>
          ${renderCourtItems(courtStats.queuedItems, '场地号：无')}
        </div>
        <button class="btn primary queue-toggle" data-action="toggle-queue">${state.queueOpen ? '收起排队' : '添加排队'}</button>
        ${state.queueOpen ? renderQueuePanel(idleCredentials, courtPreview, halfGroupOptions) : ''}
      </section>

      <section>
        <h2 class="section-title">
          <span>账号</span>
          <span class="section-hint">所有账号信息将在美国西部 PT 时间晚上 12 点清空</span>
        </h2>
        <div class="stats">
          <div class="stat-item"><div class="stat-value">${stats.total}</div><div class="stat-label">全部</div></div>
          <div class="stat-item"><div class="stat-value">${stats.idle}</div><div class="stat-label">空闲</div></div>
          <div class="stat-item"><div class="stat-value">${stats.playing}</div><div class="stat-label">正在打</div></div>
          <div class="stat-item"><div class="stat-value">${stats.queued}</div><div class="stat-label">排队</div></div>
        </div>
        ${renderAddAccount()}
        ${renderAccountList(credentials)}
      </section>
    </div>
  `;
}

function renderQueuePanel(idleCredentials, courtPreview, halfGroupOptions) {
  return `
    <div class="section">
      <h3 class="section-title">排队</h3>
      <div class="warning">本系统无法自动获取场地信息，请确保输入准确</div>
      <div class="inline-form queue-form">
        <div class="field court">
          <label for="court-name">场地号</label>
          <input id="court-name" class="input" value="${html(state.form.courtName)}" placeholder="场地编号" data-field="courtName" />
        </div>
        ${!courtPreview.hasTrackedCourt ? `
          <div class="field small">
            <label for="remaining">当前剩余分钟</label>
            <input id="remaining" class="input" type="number" min="0" max="45" value="${html(state.form.courtRemainingMinutes)}" data-field="courtRemainingMinutes" />
          </div>
          <div class="field small">
            <label for="ahead">前方排队组数</label>
            <input id="ahead" class="input" type="number" min="0" max="20" value="${html(state.form.courtAheadGroups)}" data-field="courtAheadGroups" />
          </div>
        ` : ''}
        ${renderQueueInfo(courtPreview)}
      </div>
      ${halfGroupOptions.length ? `
        <div class="half-panel">
          <strong>补全半场</strong>
          <label class="radio-row"><input type="radio" name="half" value="" ${!state.form.targetQueueEntryId ? 'checked' : ''} data-half /> 新排一组</label>
          ${halfGroupOptions.map((item) => `
            <label class="radio-row"><input type="radio" name="half" value="${html(item.id)}" ${state.form.targetQueueEntryId === item.id ? 'checked' : ''} data-half /> ${html(item.label)} · ${html(item.statusText)}</label>
          `).join('')}
        </div>
      ` : ''}
      <div class="check-list">
        ${idleCredentials.length ? idleCredentials.map((item) => `
          <label class="check-row">
            <input type="checkbox" value="${html(item._id)}" ${state.selectedIds.has(item._id) ? 'checked' : ''} data-select />
            <span class="check-account"><span class="check-name">${html(item.username)}</span><span class="check-pass">${html(item.password)}</span></span>
          </label>
        `).join('') : '<div class="empty">暂无空闲账号</div>'}
      </div>
      <div class="queue-footer">
        <div class="selected-count">已选 ${state.selectedIds.size} 个</div>
        <button class="btn primary" data-action="add-queue" ${state.savingQueue ? 'disabled' : ''}>${state.savingQueue ? '提交中' : '确认排队'}</button>
      </div>
    </div>
  `;
}

function renderAddAccount() {
  return `
    <div class="section add-account-section">
      <h3 class="section-title">添加账号</h3>
      <div class="inline-form add-account-form">
        <input id="username" class="input" maxlength="32" placeholder="用户名" aria-label="用户名" value="${html(state.form.username)}" data-field="username" />
        <input id="password" class="input" maxlength="32" placeholder="密码" aria-label="密码" value="${html(state.form.password)}" data-field="password" />
        <button class="btn primary" data-action="add-credential">确定</button>
      </div>
    </div>
  `;
}

function renderAccountList(credentials) {
  return `
    <div class="section list-section">
      <div class="list-header">
        <h3 class="section-title">账号池</h3>
        <select class="select" data-action="sort">
          <option value="default" ${state.sortMode === 'default' ? 'selected' : ''}>默认排序</option>
          <option value="createdAsc" ${state.sortMode === 'createdAsc' ? 'selected' : ''}>添加时间 早到晚</option>
          <option value="createdDesc" ${state.sortMode === 'createdDesc' ? 'selected' : ''}>添加时间 晚到早</option>
        </select>
      </div>
      ${credentials.length ? credentials.map((item) => `
        <article class="credential-card">
          <div class="credential-head">
            <div class="credential-line">
              <span class="credential-name">${html(item.username)}</span>
              ${item.canManage ? `<button class="edit-icon-button" title="修改账号" data-action="edit-credential" data-id="${html(item._id)}">✎</button>` : ''}
              ${item.canDelete ? `<button class="delete-icon-button" title="删除账号" data-action="delete-credential" data-id="${html(item._id)}">×</button>` : ''}
              <span class="credential-pass">${html(item.password)}</span>
            </div>
            <span class="status-pill status-${html(item.status)}">${html(item.statusText)}</span>
            ${item.canCancelQueue ? `<button class="cancel-icon-button danger" data-action="open-cancel" data-entry-id="${html(item.currentQueueEntryId)}">取消</button>` : ''}
          </div>
          ${item.courtName ? `<div class="meta-row"><span>场地号：${html(item.courtName)}</span>${item.hasGroupNo ? `<span>第 ${html(item.groupNo)} 组</span>` : ''}<span>${html(item.timeText)}</span></div>` : ''}
          <div class="meta-row"><span>${html(item.ownerText)}</span>${item.createdAtText ? `<span>${html(item.createdAtText)}</span>` : ''}</div>
        </article>
      `).join('') : '<div class="empty">暂无账号</div>'}
    </div>
  `;
}

function renderGroupModal() {
  if (state.modal !== 'groups') return '';
  return `
    <div class="overlay">
      <div class="modal">
        <h2>球群</h2>
        <p>创建新球群，或切换到登录后参与过的球群。</p>
        <div class="inline-form">
          <div class="field">
            <label for="modal-group-name">新球群名称</label>
            <input id="modal-group-name" class="input" value="${html(state.form.groupName)}" data-field="groupName" />
          </div>
          <button class="btn primary" data-action="create-group">创建</button>
        </div>
        <div class="check-list">
          ${state.groups.map((group) => `
            <button class="btn" data-action="switch-group" data-id="${html(group._id)}" style="width:100%;margin-top:8px">${html(group.displayName)}</button>
          `).join('') || '<div class="empty">还没有加入任何球群</div>'}
        </div>
        <div class="modal-actions">
          <button class="btn" data-action="close-modal">关闭</button>
        </div>
      </div>
    </div>
  `;
}

function renderCancelModal() {
  if (state.modal !== 'cancel') return '';
  const entry = state.queueEntries.find((item) => item._id === state.cancelEntryId);
  if (!entry) return '';
  const credentialsById = Object.fromEntries(state.credentials.map((item) => [item._id, item]));
  const options = (entry.credentialIds || [])
    .map((id) => credentialsById[id] || { _id: id, username: id, password: '' })
    .filter((credential) => state.user && credential.createdByUserId === state.user._id);
  const canConfirm = state.cancelSelectedIds.size === 2 || state.cancelSelectedIds.size === 4;
  return `
    <div class="overlay bottom">
      <div class="modal">
        <h2>选择要取消的账号</h2>
        <p>必须选择 2 个或 4 个。</p>
        ${options.map((item) => `
          <label class="cancel-row">
            <input type="checkbox" value="${html(item._id)}" ${state.cancelSelectedIds.has(item._id) ? 'checked' : ''} data-cancel-select />
            <span class="check-account"><span class="check-name">${html(item.username)}</span><span class="check-pass">${html(item.password)}</span></span>
          </label>
        `).join('')}
        <div class="modal-actions">
          <button class="btn" data-action="close-modal">返回</button>
          <button class="btn danger" data-action="confirm-cancel" ${canConfirm ? '' : 'disabled'}>确认取消</button>
        </div>
      </div>
    </div>
  `;
}

function buildHeatmap() {
  const counts = new Map();
  state.history.forEach((item) => {
    counts.set(item.dateKey, (counts.get(item.dateKey) || 0) + 1);
  });
  const days = [];
  const today = new Date();
  for (let index = 119; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const count = counts.get(key) || 0;
    days.push({ key, count, level: Math.min(4, count) });
  }
  return days;
}

function renderAdminPanel() {
  if (!state.user?.isSuperAdmin) return '';
  const adminEmails = state.user.adminEmails || [];
  return `
    <h3 class="settings-subtitle">管理员</h3>
    <div class="inline-form">
      <div class="field">
        <label for="admin-email">常规管理员邮箱</label>
        <input id="admin-email" class="input" type="email" value="${html(state.form.adminEmail)}" data-field="adminEmail" />
      </div>
      <button class="btn primary" data-action="add-admin">添加</button>
    </div>
    <div class="admin-list">
      ${adminEmails.length ? adminEmails.map((email) => `
        <div class="admin-row">
          <span>${html(email)}</span>
          <button class="btn danger" data-action="remove-admin" data-email="${html(email)}">删除</button>
        </div>
      `).join('') : '<div class="empty">暂无常规管理员</div>'}
    </div>
  `;
}

function renderSettingsModal() {
  if (state.modal !== 'settings') return '';
  if (!state.user) {
    return `
      <div class="overlay">
        <div class="modal settings-modal">
          <h2>登录</h2>
          <p>登录后可以修改或删除自己填写的用户名密码、保存参与过的球群，并查看自己的打球历史。</p>
          ${state.googleClientId ? '<div id="google-signin" class="google-signin"></div>' : '<div class="empty">部署时配置 GOOGLE_CLIENT_ID 后可启用 Google 登录。</div>'}
          <div class="modal-actions">
            <button class="btn" data-action="close-modal">关闭</button>
          </div>
        </div>
      </div>
    `;
  }

  const heatmap = buildHeatmap();
  return `
    <div class="overlay">
      <div class="modal settings-modal">
        <h2>个人设置</h2>
        <p>${html(state.user.email)}</p>
        <div class="inline-form">
          <div class="field">
            <label for="display-name">Display name</label>
            <input id="display-name" class="input" maxlength="32" value="${html(state.form.displayName)}" data-field="displayName" />
          </div>
          <button class="btn primary" data-action="save-profile">保存</button>
        </div>
        <h3 class="settings-subtitle">打球历史</h3>
        <div class="heatmap" aria-label="打球历史热力图">
          ${heatmap.map((day) => `<span class="heat heat-${day.level}" title="${html(day.key)} · ${day.count} 次"></span>`).join('')}
        </div>
        ${renderAdminPanel()}
        <h3 class="settings-subtitle">参与过的球群</h3>
        <div class="settings-groups">
          ${state.groups.length ? state.groups.map((group) => `
            <button class="btn" data-action="switch-group" data-id="${html(group._id)}">${html(group.displayName)}</button>
          `).join('') : '<div class="empty">暂无记录</div>'}
        </div>
        <div class="modal-actions">
          <button class="btn danger" data-action="logout">退出登录</button>
          <button class="btn" data-action="close-modal">关闭</button>
        </div>
      </div>
    </div>
  `;
}

function renderEditModal() {
  if (state.modal !== 'edit') return '';
  return `
    <div class="overlay">
      <div class="modal">
        <h2>修改账号</h2>
        <div class="inline-form">
          <div class="field">
            <label for="edit-username">用户名</label>
            <input id="edit-username" class="input" maxlength="32" value="${html(state.form.editUsername)}" data-field="editUsername" />
          </div>
          <div class="field">
            <label for="edit-password">密码</label>
            <input id="edit-password" class="input" maxlength="32" value="${html(state.form.editPassword)}" data-field="editPassword" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" data-action="close-modal">取消</button>
          <button class="btn primary" data-action="save-credential">保存</button>
        </div>
      </div>
    </div>
  `;
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1 class="title">羽毛球 Drop-in 排队管理</h1>
        <div class="subtitle">${state.currentGroup ? html(state.currentGroup.displayName) : '选择或创建一个球群'}${state.storage === 'memory' ? ' · 本地内存模式' : ''}</div>
      </div>
      <div class="toolbar">
        <button class="btn secondary" data-action="open-groups" ${state.user ? '' : 'disabled'}>切换球群</button>
        <button class="btn primary" data-action="share" ${state.currentGroup ? '' : 'disabled'}>分享链接</button>
        <button class="btn" data-action="open-settings">${state.user ? html(state.user.displayName || state.user.email) : '登录'}</button>
      </div>
    </header>
    ${renderJoinBanner()}
    ${renderDashboard()}
    ${renderGroupModal()}
    ${renderCancelModal()}
    ${renderSettingsModal()}
    ${renderEditModal()}
  `;
  bindEvents();
  loadGoogleButton();
}

function bindEvents() {
  app.querySelectorAll('[data-field]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const field = event.currentTarget.dataset.field;
      state.form[field] = event.currentTarget.value;
      if (field === 'courtName') state.form.targetQueueEntryId = '';
      if (['courtName', 'courtRemainingMinutes', 'courtAheadGroups'].includes(field)) updateQueueInfo();
    });
    if (input.dataset.field === 'courtName') {
      input.addEventListener('change', render);
    }
  });

  app.querySelectorAll('[data-select]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const id = event.currentTarget.value;
      if (event.currentTarget.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      render();
    });
  });

  app.querySelectorAll('[data-half]').forEach((input) => {
    input.addEventListener('change', (event) => {
      state.form.targetQueueEntryId = event.currentTarget.value;
      render();
    });
  });

  app.querySelectorAll('[data-cancel-select]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const id = event.currentTarget.value;
      if (event.currentTarget.checked) state.cancelSelectedIds.add(id);
      else state.cancelSelectedIds.delete(id);
      render();
    });
  });

  app.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', async (event) => {
      const action = event.currentTarget.dataset.action;
      if (action === 'refresh') await refreshDashboard();
      if (action === 'open-groups') {
        if (!state.user) {
          showToast('登录后可以切换参与过的球群');
          return;
        }
        state.modal = 'groups';
        render();
      }
      if (action === 'close-modal') {
        state.modal = '';
        render();
      }
      if (action === 'create-group') await createGroup();
      if (action === 'join-link') await joinGroup();
      if (action === 'switch-group') {
        pickCurrentGroup(event.currentTarget.dataset.id);
        state.modal = '';
        state.selectedIds.clear();
        await refreshDashboard(false);
      }
      if (action === 'share') shareGroup();
      if (action === 'toggle-queue') {
        state.queueOpen = !state.queueOpen;
        render();
      }
      if (action === 'add-credential') await addCredential();
      if (action === 'delete-credential') await deleteCredential(event.currentTarget.dataset.id);
      if (action === 'edit-credential') {
        const credential = state.credentials.find((item) => item._id === event.currentTarget.dataset.id);
        if (!credential) return;
        state.editingCredentialId = credential._id;
        state.form.editUsername = credential.username || '';
        state.form.editPassword = credential.password || '';
        state.modal = 'edit';
        render();
      }
      if (action === 'save-credential') await updateCredential();
      if (action === 'add-queue') await addQueueEntry();
      if (action === 'open-cancel') openCancel(event.currentTarget.dataset.entryId);
      if (action === 'confirm-cancel') await cancelQueueEntry(state.cancelEntryId, Array.from(state.cancelSelectedIds));
      if (action === 'open-settings') {
        state.modal = 'settings';
        await loadMyHistory();
        render();
      }
      if (action === 'save-profile') await saveProfile();
      if (action === 'add-admin') await addAdminEmail();
      if (action === 'remove-admin') await removeAdminEmail(event.currentTarget.dataset.email);
      if (action === 'logout') await logout();
    });
  });

  const sort = app.querySelector('[data-action="sort"]');
  if (sort) {
    sort.addEventListener('change', (event) => {
      state.sortMode = event.currentTarget.value;
      localStorage.setItem('credentialSortMode', state.sortMode);
      render();
    });
  }
}

setInterval(() => {
  state.nowTs = Date.now();
  if (isEditingFormField()) updateQueueInfo();
  else render();
}, 30000);

render();
init();
