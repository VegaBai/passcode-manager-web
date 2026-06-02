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
  bulk: {
    rawText: '',
    rows: [],
    parsed: false,
    parsedCount: 0,
    ignoredCount: 0,
    duplicateCount: 0,
    unchangedCount: 0
  },
  joinGroupId: new URLSearchParams(location.search).get('group') || '',
  sortMode: localStorage.getItem('credentialSortMode') || 'default',
  queueOpen: false,
  form: {
    groupName: 'Fremont Bintang',
    groupSettingsName: '',
    groupAdminEmail: '',
    displayName: '',
    adminEmail: '',
    editUsername: '',
    editPassword: '',
    username: '',
    password: '',
    courtName: '',
    courtRemainingMinutes: '',
    courtQueueGroupNo: '1',
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

function usernameKey(value) {
  return String(value || '').trim().toLowerCase();
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

function parseQueueGroupNo(value) {
  const groupNo = Number(value);
  if (!Number.isFinite(groupNo)) return 1;
  return Math.max(0, Math.min(4, Math.floor(groupNo)));
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
    shortId: group._id ? group._id.slice(-8) : '',
    adminEmails: Array.isArray(group.adminEmails) ? group.adminEmails : [],
    canManageGroup: Boolean(group.canManageGroup)
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
  if (!state.user) {
    showToast('请先登录后创建球群');
    state.modal = 'settings';
    render();
    return;
  }
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

function resetBulkState(rawText = '') {
  state.bulk = {
    rawText,
    rows: [],
    parsed: false,
    parsedCount: 0,
    ignoredCount: 0,
    duplicateCount: 0,
    unchangedCount: 0
  };
}

function openBulkModal() {
  resetBulkState();
  state.modal = 'bulk';
  render();
}

function parseBulkText() {
  const existingByUsername = new Map(state.credentials.map((item) => [usernameKey(item.username), item]));
  const entriesByUsername = new Map();
  let parsedCount = 0;
  let ignoredCount = 0;
  let duplicateCount = 0;

  state.bulk.rawText.split(/\r?\n/).forEach((line) => {
    const matched = line.match(/^\s*(\d+)(?:\s*[\.．。、\)、）:：]\s*|\s+)(.+)$/);
    if (!matched) return;

    const parts = matched[2].trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      ignoredCount += 1;
      return;
    }

    const entry = {
      sequence: matched[1],
      username: parts[0],
      password: parts[1]
    };
    parsedCount += 1;
    const key = usernameKey(entry.username);
    if (entriesByUsername.has(key)) duplicateCount += 1;
    entriesByUsername.set(key, entry);
  });

  const rows = Array.from(entriesByUsername.values()).reduce((result, entry, index) => {
    const existing = existingByUsername.get(usernameKey(entry.username));
    if (existing && existing.password === entry.password) return result;
    result.push({
      id: `bulk_${index}_${entry.sequence}_${entry.username}`,
      selected: true,
      mode: existing ? 'update' : 'add',
      sequence: entry.sequence,
      credentialId: existing?._id || '',
      originalUsername: existing?.username || '',
      originalPassword: existing?.password || '',
      username: existing?.username || entry.username,
      password: entry.password
    });
    return result;
  }, []);

  state.bulk.rows = rows;
  state.bulk.parsed = true;
  state.bulk.parsedCount = parsedCount;
  state.bulk.ignoredCount = ignoredCount;
  state.bulk.duplicateCount = duplicateCount;
  state.bulk.unchangedCount = entriesByUsername.size - rows.length;
}

function validateBulkRows(rows) {
  if (!rows.length) return '请选择至少一条要添加或修改的账号';

  const usernames = new Set();
  for (const row of rows) {
    if (!ALNUM.test(row.username) || !ALNUM.test(row.password)) {
      return '用户名和密码只能包含英文或数字';
    }
    const key = usernameKey(row.username);
    if (usernames.has(key)) {
      return `批量列表里有重复用户名：${row.username}`;
    }
    usernames.add(key);
  }
  return '';
}

async function submitBulkCredentials() {
  if (!state.currentGroup) return;
  const selectedRows = state.bulk.rows
    .filter((row) => row.selected)
    .map((row) => ({
      mode: row.mode,
      credentialId: row.credentialId,
      username: row.username.trim(),
      password: row.password.trim()
    }));

  const validationMessage = validateBulkRows(selectedRows);
  if (validationMessage) {
    showToast(validationMessage);
    return;
  }

  try {
    const result = await callApi('bulkUpsertCredentials', {
      groupId: state.currentGroup._id,
      items: selectedRows
    });
    resetBulkState();
    state.modal = '';
    await refreshDashboard(false);
    showToast(`已添加 ${result.added || 0} 个，已更新 ${result.updated || 0} 个`);
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

function syncGroupResult(result) {
  state.groups = normalizeGroups(result.groups || state.groups);
  state.currentGroup = result.currentGroup ? normalizeGroups([result.currentGroup])[0] : state.currentGroup;
  if (state.currentGroup) pickCurrentGroup(state.currentGroup._id);
}

function syncDeletedGroup(result) {
  const deletedGroupId = result.deletedGroupId || '';
  state.groups = normalizeGroups(result.groups || state.groups).filter((group) => group._id !== deletedGroupId);
  state.history = state.history.filter((item) => item.groupId !== deletedGroupId);

  if (state.currentGroup?._id === deletedGroupId) {
    state.currentGroup = null;
    state.credentials = [];
    state.queueEntries = [];
    state.selectedIds.clear();
    state.cancelSelectedIds.clear();
    state.queueOpen = false;
    localStorage.removeItem('currentGroupId');
    pickCurrentGroup();
    return;
  }

  if (state.currentGroup) {
    const refreshed = state.groups.find((group) => group._id === state.currentGroup._id);
    state.currentGroup = refreshed || state.currentGroup;
  }
}

async function saveGroupSettings() {
  if (!state.currentGroup) return;
  const name = state.form.groupSettingsName.trim();
  if (!name) {
    showToast('请输入球群名称');
    return;
  }
  try {
    const result = await callApi('updateGroupSettings', { groupId: state.currentGroup._id, name });
    syncGroupResult(result);
    showToast('球群设置已保存');
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function addGroupAdmin() {
  if (!state.currentGroup) return;
  const email = state.form.groupAdminEmail.trim();
  if (!email) {
    showToast('请输入管理员邮箱');
    return;
  }
  try {
    const result = await callApi('addGroupAdmin', { groupId: state.currentGroup._id, email });
    syncGroupResult(result);
    state.form.groupAdminEmail = '';
    showToast('球群管理员已添加');
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function removeGroupAdmin(email) {
  if (!state.currentGroup) return;
  try {
    const result = await callApi('removeGroupAdmin', { groupId: state.currentGroup._id, email });
    syncGroupResult(result);
    showToast('球群管理员已删除');
  } catch (error) {
    showToast(error.message);
  }
  render();
}

async function deleteGroup(groupId, groupName) {
  if (!state.user?.isSuperAdmin) return;
  const name = groupName || '这个球群';
  const confirmed = confirm(`确定删除「${name}」吗？该球群的账号池、排队、打球历史都会一起删除。`);
  if (!confirmed) return;
  try {
    const result = await callApi('deleteGroup', { groupId });
    syncDeletedGroup(result);
    if (state.currentGroup) await refreshDashboard(false);
    showToast('球群已删除');
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
  const selectedQueueEntry = findQueueEntryByGroupNo(parseQueueGroupNo(state.form.courtQueueGroupNo));
  const selectedQueueCount = selectedQueueEntry ? participantCount(selectedQueueEntry) : 0;
  if (selectedQueueCount >= 4) {
    showToast(`第${state.form.courtQueueGroupNo}组已经排满`);
    return;
  }
  state.form.targetQueueEntryId = selectedQueueCount === 2 ? selectedQueueEntry._id : '';
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
    const courtPreview = buildCourtPreview();
    await callApi('addQueueEntry', {
      groupId: state.currentGroup._id,
      courtName,
      courtRemainingMinutes: courtPreview.remainingMinutes,
      courtQueueGroupNo: parseQueueGroupNo(state.form.courtQueueGroupNo),
      targetQueueEntryId: state.form.targetQueueEntryId,
      credentialIds: selectedIds
    });
    state.selectedIds.clear();
    state.form.courtRemainingMinutes = '';
    state.form.courtQueueGroupNo = '1';
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
  const canEditAny = Boolean(state.user?.isAdmin);
  const canDeleteAny = Boolean(state.user?.isAdmin || state.currentGroup?.canManageGroup);

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
      canManage: Boolean((isOwner || canEditAny) && item.status === 'idle'),
      canDelete: Boolean((isOwner || canDeleteAny) && item.status === 'idle'),
      canCancelQueue: Boolean(item.status === 'playing' || item.status === 'queued')
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

function findQueueEntryByGroupNo(groupNo) {
  const courtName = state.form.courtName.trim();
  if (!courtName) return null;
  return state.queueEntries.find((entry) => {
    return entry.courtName === courtName
      && ['playing', 'queued'].includes(entry.status)
      && Number(entry.groupNo) === groupNo;
  }) || null;
}

function hasManualRemainingMinutes() {
  return String(state.form.courtRemainingMinutes || '').trim() !== '';
}

function getZeroGroupRemaining(entries) {
  if (hasManualRemainingMinutes()) return parseRemainingMinutes(state.form.courtRemainingMinutes);
  const playing = entries.find((entry) => entry.status === 'playing');
  if (playing) return minutesUntil(playing.endAt);
  return 0;
}

function waitMinutesForGroup(groupNo, zeroGroupRemaining) {
  if (groupNo <= 0) return 0;
  return zeroGroupRemaining + Math.max(0, groupNo - 1) * 45;
}

function buildCourtPreview() {
  const courtName = state.form.courtName.trim();
  const queueGroupNo = parseQueueGroupNo(state.form.courtQueueGroupNo);
  if (!courtName) {
    const remainingMinutes = getZeroGroupRemaining([]);
    return {
      nextGroupNo: queueGroupNo,
      remainingMinutes,
      waitMinutes: waitMinutesForGroup(queueGroupNo, remainingMinutes),
      hasTrackedCourt: false
    };
  }

  const entries = state.queueEntries.filter((entry) => entry.courtName === courtName);
  const remainingMinutes = getZeroGroupRemaining(entries);
  if (!entries.length) {
    return {
      nextGroupNo: queueGroupNo,
      remainingMinutes,
      waitMinutes: waitMinutesForGroup(queueGroupNo, remainingMinutes),
      hasTrackedCourt: false
    };
  }

  const targetEntry = state.form.targetQueueEntryId
    ? entries.find((entry) => entry._id === state.form.targetQueueEntryId)
    : entries.find((entry) => Number(entry.groupNo) === queueGroupNo && participantCount(entry) > 0);
  if (targetEntry) {
    return {
      nextGroupNo: Number(targetEntry.groupNo || 0),
      remainingMinutes,
      waitMinutes: targetEntry.status === 'queued' ? minutesUntil(targetEntry.startAt) : 0,
      hasTrackedCourt: true
    };
  }

  return {
    nextGroupNo: queueGroupNo,
    remainingMinutes,
    waitMinutes: waitMinutesForGroup(queueGroupNo, remainingMinutes),
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
    <div>场上第0组剩余 ${courtPreview.remainingMinutes} 分钟</div>
    <div>预计等待 ${courtPreview.waitMinutes} 分钟</div>
  `;
}

function renderQueueInfo(courtPreview) {
  return `<div class="queue-info" data-queue-info>${renderQueueInfoContent(courtPreview)}</div>`;
}

function renderQueueGroupOptions() {
  const selectedGroupNo = parseQueueGroupNo(state.form.courtQueueGroupNo);
  const options = [0, 1, 2, 3, 4];
  return `
    <div class="queue-position-panel">
      <strong>加入场地排队：</strong>
      <div class="queue-position-options">
        ${options.map((groupNo) => {
          const entry = findQueueEntryByGroupNo(groupNo);
          const count = entry ? participantCount(entry) : 0;
          const disabled = count >= 4;
          const baseLabel = groupNo === 0 ? '第0组（正在打）' : `第${groupNo}组`;
          const label = count > 0 && groupNo === 0
            ? `第0组（正在打，已排${count}）`
            : count > 0
              ? `${baseLabel}（已排${count}）`
              : baseLabel;
          return `
            <label class="radio-row ${disabled ? 'is-disabled' : ''}">
              <input type="radio" name="queue-group" value="${groupNo}" data-target-id="${html(entry?._id || '')}" ${selectedGroupNo === groupNo && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-queue-group />
              ${html(label)}
            </label>
          `;
        }).join('')}
      </div>
    </div>
  `;
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

  return `
    <section class="section">
      <div class="group-row">
        <div class="group-label">球群</div>
        <div class="group-name">${html(state.currentGroup.displayName)}</div>
        <div class="invite-code">邀请码 ${html(state.currentGroup.shortId || state.currentGroup._id)}</div>
        ${state.currentGroup.canManageGroup ? '<button class="btn icon" title="球群设置" aria-label="球群设置" data-action="open-group-settings">⚙</button>' : ''}
      </div>
    </section>

    <div class="divider"></div>

    <div class="content-grid">
      <section>
        <button class="btn refresh-above-courts" data-action="refresh"><span class="refresh-icon" aria-hidden="true">↻</span>${state.loading ? '刷新中' : '刷新'}</button>
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
        ${state.queueOpen ? renderQueuePanel(idleCredentials, courtPreview) : ''}
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

function renderQueuePanel(idleCredentials, courtPreview) {
  return `
    <div class="section">
      <h3 class="section-title">排队</h3>
      <div class="warning">本系统无法自动获取场地信息，请确保输入准确</div>
      <div class="inline-form queue-form">
        <div class="field court">
          <label for="court-name">场地号</label>
          <input id="court-name" class="input" value="${html(state.form.courtName)}" placeholder="场地编号" data-field="courtName" />
        </div>
        <div class="field small">
          <label for="remaining">场上第0组剩余时间</label>
          <input id="remaining" class="input" type="number" min="0" max="45" value="${html(state.form.courtRemainingMinutes)}" data-field="courtRemainingMinutes" />
        </div>
        ${renderQueueInfo(courtPreview)}
      </div>
      ${renderQueueGroupOptions()}
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
        <button class="btn secondary" data-action="open-bulk">批量添加</button>
      </div>
      ${state.user ? '' : '<div class="add-account-warning">仅登录后添加的密码可修改和删除</div>'}
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

function renderGroupSettingsModal() {
  if (state.modal !== 'group-settings' || !state.currentGroup) return '';
  const adminEmails = state.currentGroup.adminEmails || [];
  const nameValue = state.form.groupSettingsName || state.currentGroup.name || state.currentGroup.displayName;
  return `
    <div class="overlay">
      <div class="modal settings-modal">
        <h2>球群设置</h2>
        <div class="inline-form">
          <div class="field">
            <label for="group-settings-name">球群名称</label>
            <input id="group-settings-name" class="input" maxlength="60" value="${html(nameValue)}" data-field="groupSettingsName" />
          </div>
          <button class="btn primary" data-action="save-group-settings">保存</button>
        </div>
        <h3 class="settings-subtitle">球群管理员</h3>
        <p class="settings-description">管理员可修改球群名称、添加或移除球群管理员，并删除本球群内空闲账号。</p>
        <div class="inline-form">
          <div class="field">
            <label for="group-admin-email">管理员邮箱</label>
            <input id="group-admin-email" class="input" type="email" value="${html(state.form.groupAdminEmail)}" data-field="groupAdminEmail" />
          </div>
          <button class="btn primary" data-action="add-group-admin">添加</button>
        </div>
        <div class="admin-list">
          ${adminEmails.length ? adminEmails.map((email) => `
            <div class="admin-row">
              <span>${html(email)}</span>
              <button class="btn danger" data-action="remove-group-admin" data-email="${html(email)}">删除</button>
            </div>
          `).join('') : '<div class="empty">暂无球群管理员</div>'}
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
    .map((id) => credentialsById[id] || { _id: id, username: id, password: '' });
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

function renderSettingsGroupList() {
  const title = state.user?.isSuperAdmin ? '所有球群' : (state.user?.isAdmin ? '可管理的球群' : '参与过的球群');
  return `
    <h3 class="settings-subtitle">${title}</h3>
    <div class="settings-groups">
      ${state.groups.length ? state.groups.map((group) => {
        const meta = [
          group.ownerDisplayName ? `创建者 ${group.ownerDisplayName}` : '',
          `${group.memberCount || 0} 人`,
          `${group.activeCredentialCount || 0} 个账号`,
          `${group.activeQueueEntryCount || 0} 条排队`
        ].filter(Boolean).join(' · ');
        return `
          <div class="settings-group-row">
            <button class="btn settings-group-main" data-action="switch-group" data-id="${html(group._id)}">
              <span>${html(group.displayName)}</span>
              <small>${html(meta)}</small>
            </button>
            ${state.user?.isSuperAdmin ? `<button class="btn danger" data-action="delete-group" data-id="${html(group._id)}" data-name="${html(group.displayName)}">删除</button>` : ''}
          </div>
        `;
      }).join('') : '<div class="empty">暂无记录</div>'}
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
        ${renderSettingsGroupList()}
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

function renderBulkModal() {
  if (state.modal !== 'bulk') return '';
  const selectedCount = state.bulk.rows.filter((row) => row.selected).length;
  const summaryParts = [
    `识别 ${state.bulk.parsedCount} 条`,
    state.bulk.unchangedCount ? `${state.bulk.unchangedCount} 条无变化` : '',
    state.bulk.ignoredCount ? `${state.bulk.ignoredCount} 条缺少密码已忽略` : '',
    state.bulk.duplicateCount ? `${state.bulk.duplicateCount} 个重复用户名按最后一条处理` : ''
  ].filter(Boolean);

  return `
    <div class="overlay">
      <div class="modal bulk-modal">
        <h2>批量添加账号</h2>
        <p>粘贴接龙内容后先解析，只会列出新账号和密码有变化的账号。</p>
        <textarea class="input bulk-textarea" data-bulk-text placeholder="请粘贴接龙内容：&#10;&#10;1. Jayx wolf79&#10;2. aa deer7">${html(state.bulk.rawText)}</textarea>
        <div class="bulk-toolbar">
          <div class="bulk-summary">${summaryParts.join(' · ') || '等待解析'}</div>
          <button class="btn secondary" data-action="parse-bulk">解析粘贴内容</button>
        </div>
        <div class="bulk-list">
          ${state.bulk.rows.length ? state.bulk.rows.map((row) => `
            <div class="bulk-row">
              <label class="bulk-check">
                <input type="checkbox" data-bulk-select data-id="${html(row.id)}" ${row.selected ? 'checked' : ''} />
                <span class="bulk-mode ${row.mode === 'add' ? 'add' : 'update'}">${row.mode === 'add' ? '新增' : '修改'}</span>
              </label>
              <div class="bulk-fields">
                <input class="input" maxlength="32" value="${html(row.username)}" data-bulk-row-field="username" data-id="${html(row.id)}" aria-label="用户名" />
                <input class="input" maxlength="32" value="${html(row.password)}" data-bulk-row-field="password" data-id="${html(row.id)}" aria-label="密码" />
              </div>
              ${row.mode === 'update' ? `<div class="bulk-before">${html(row.originalUsername)} / ${html(row.originalPassword)}</div>` : '<div class="bulk-before">新账号</div>'}
            </div>
          `).join('') : (state.bulk.parsed ? '<div class="bulk-empty-danger">没有新增或修改的账号</div>' : '<div class="empty">解析后会在这里显示需要新增或修改的账号</div>')}
        </div>
        <div class="modal-actions">
          <button class="btn" data-action="close-modal">取消</button>
          <button class="btn primary" data-action="submit-bulk" ${selectedCount ? '' : 'disabled'}>确认添加/修改</button>
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
        ${state.user ? '' : '<div class="login-required-note">登录后可切换球群、添加新球群页面</div>'}
      </div>
    </header>
    ${renderJoinBanner()}
    ${renderDashboard()}
    ${renderGroupModal()}
    ${renderGroupSettingsModal()}
    ${renderCancelModal()}
    ${renderSettingsModal()}
    ${renderEditModal()}
    ${renderBulkModal()}
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
      if (['courtName', 'courtRemainingMinutes'].includes(field)) updateQueueInfo();
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

  app.querySelectorAll('[data-queue-group]').forEach((input) => {
    input.addEventListener('change', (event) => {
      state.form.courtQueueGroupNo = event.currentTarget.value;
      state.form.targetQueueEntryId = event.currentTarget.dataset.targetId || '';
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

  app.querySelectorAll('[data-bulk-text]').forEach((input) => {
    input.addEventListener('input', (event) => {
      state.bulk.rawText = event.currentTarget.value;
    });
  });

  app.querySelectorAll('[data-bulk-select]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const row = state.bulk.rows.find((item) => item.id === event.currentTarget.dataset.id);
      if (row) row.selected = event.currentTarget.checked;
      render();
    });
  });

  app.querySelectorAll('[data-bulk-row-field]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const row = state.bulk.rows.find((item) => item.id === event.currentTarget.dataset.id);
      const field = event.currentTarget.dataset.bulkRowField;
      if (row && ['username', 'password'].includes(field)) row[field] = event.currentTarget.value;
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
      if (action === 'open-group-settings') {
        if (!state.currentGroup?.canManageGroup) {
          showToast('没有权限管理这个球群');
          return;
        }
        state.form.groupSettingsName = state.currentGroup.name || state.currentGroup.displayName || '';
        state.form.groupAdminEmail = '';
        state.modal = 'group-settings';
        render();
      }
      if (action === 'toggle-queue') {
        state.queueOpen = !state.queueOpen;
        render();
      }
      if (action === 'add-credential') await addCredential();
      if (action === 'open-bulk') openBulkModal();
      if (action === 'parse-bulk') {
        parseBulkText();
        render();
      }
      if (action === 'submit-bulk') await submitBulkCredentials();
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
      if (action === 'save-group-settings') await saveGroupSettings();
      if (action === 'add-group-admin') await addGroupAdmin();
      if (action === 'remove-group-admin') await removeGroupAdmin(event.currentTarget.dataset.email);
      if (action === 'delete-group') await deleteGroup(event.currentTarget.dataset.id, event.currentTarget.dataset.name);
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
