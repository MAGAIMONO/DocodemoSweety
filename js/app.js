/**
 * Retro DS Web Emulator - Main Application Controller
 * Optimized for Android portrait & landscape play with direct stylus touch support.
 */

import {
  saveRom,
  getRom,
  listRoms,
  touchRom,
  deleteRom,
  saveSram,
  loadSram,
  saveStateSlot,
  loadStateSlot,
  getStateSlotsMeta,
  saveBiosFile,
  listBiosMeta,
  loadAllBiosFiles,
  deleteBiosFile,
  loadSettings,
  saveSettings,
  requestPersistentStorage
} from './storage.js';
import { DSController } from './gamepad.js';
import { RetroDSEmulator, getLayoutInfo, getLayoutDimensions, getCoreInfo } from './emulator.js';

// Register Service Worker for PWA installability
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// DOM Elements
const screenStage = document.getElementById('screen-stage');
const screenViewport = document.getElementById('screen-viewport');
const dsHingeGap = document.getElementById('ds-hinge-gap');
const stylusIndicator = document.getElementById('stylus-indicator');
const canvas = document.getElementById('game-canvas');
const bootOverlay = document.getElementById('boot-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const toastEl = document.getElementById('toast');

const ledPower = document.getElementById('led-power');
const ledStatus = document.getElementById('led-status');

const btnResumeLast = document.getElementById('btn-resume-last');
const btnPickRomMain = document.getElementById('btn-pick-rom-main');
const btnOpenLibraryMain = document.getElementById('btn-open-library-main');

const btnLibrary = document.getElementById('btn-library');
const btnQuickSave = document.getElementById('btn-quick-save');
const btnQuickLoad = document.getElementById('btn-quick-load');
const btnLayoutCycle = document.getElementById('btn-layout-cycle');
const btnFastForward = document.getElementById('btn-fast-forward');
const btnMute = document.getElementById('btn-mute');
const btnMenu = document.getElementById('btn-menu');

const romFileInput = document.getElementById('rom-file-input');
const savFileInput = document.getElementById('sav-file-input');
const biosFileInput = document.getElementById('bios-file-input');

const modalLibrary = document.getElementById('modal-library');
const modalMenu = document.getElementById('modal-menu');
const btnAddRom = document.getElementById('btn-add-rom');
const romListEl = document.getElementById('rom-list');
const stateSlotsEl = document.getElementById('state-slots');
const biosListEl = document.getElementById('bios-list');
const btnAddBios = document.getElementById('btn-add-bios');

const btnPauseResume = document.getElementById('btn-pause-resume');
const btnRestart = document.getElementById('btn-restart');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnExitGame = document.getElementById('btn-exit-game');
const btnExportSav = document.getElementById('btn-export-sav');
const btnImportSav = document.getElementById('btn-import-sav');

const themePicker = document.getElementById('theme-picker');
const selectCore = document.getElementById('select-core');
const selectLayout = document.getElementById('select-layout');
const selectGap = document.getElementById('select-gap');
const selectFrameskip = document.getElementById('select-frameskip');
const selectFilter = document.getElementById('select-filter');
const toggleVibrate = document.getElementById('toggle-vibrate');
const toggleTouchRipple = document.getElementById('toggle-touch-ripple');
const selectFfSpeed = document.getElementById('select-ff-speed');
const rangePadScale = document.getElementById('range-pad-scale');
const valPadScale = document.getElementById('val-pad-scale');
const rangeDeckOffset = document.getElementById('range-deck-offset');
const valDeckOffset = document.getElementById('val-deck-offset');
const btnResetLayout = document.getElementById('btn-reset-layout');
const storageStatusEl = document.getElementById('storage-status');

const LAYOUT_CYCLE_ORDER = ['top-bottom', 'hybrid-top', 'hybrid-bottom', 'left-right', 'bottom-only'];

let settings = loadSettings();
let latestRomMeta = null;
let toastTimer = null;

function showToast(msg, duration = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

function setLoading(visible, text = '読み込み中...') {
  loadingText.textContent = text;
  loadingOverlay.classList.toggle('hidden', !visible);
}

function openModal(modal) {
  modal.classList.remove('hidden');
}

function closeModal(modal) {
  modal.classList.add('hidden');
}

/* ---------- Stylus Visual Feedback (Non-intrusive overlay) ---------- */
function bindStylusFeedback(targetCanvas) {
  if (!targetCanvas) return;

  const showDot = (e) => {
    if (!settings.touchRipple || !emulator.isRunning) return;
    let x = e.clientX;
    let y = e.clientY;
    if (targetCanvas.ownerDocument === document) {
      const rect = screenViewport.getBoundingClientRect();
      x -= rect.left;
      y -= rect.top;
    }
    stylusIndicator.style.left = `${x}px`;
    stylusIndicator.style.top = `${y}px`;
    stylusIndicator.classList.add('active');
  };

  const hideDot = () => {
    stylusIndicator.classList.remove('active');
  };

  targetCanvas.addEventListener('pointerdown', showDot, { passive: true });
  targetCanvas.addEventListener('pointermove', (e) => {
    if (e.buttons > 0 || e.pressure > 0) showDot(e);
  }, { passive: true });
  targetCanvas.addEventListener('pointerup', hideDot, { passive: true });
  targetCanvas.addEventListener('pointercancel', hideDot, { passive: true });
}

// Initialize Emulator & Controller
const emulator = new RetroDSEmulator({
  canvas,
  onStatus: (msg) => setLoading(true, msg),
  onCanvasReplaced: (freshCanvas) => bindStylusFeedback(freshCanvas)
});

bindStylusFeedback(canvas);

const controller = new DSController({
  vibrateEnabled: settings.vibrate,
  onPress: (btn) => emulator.pressDown(btn),
  onRelease: (btn) => emulator.pressUp(btn)
});

/* ---------- Apply Settings & Layout ---------- */
function applySettings() {
  const layout = getLayoutInfo(settings.screenLayout);
  const dims = getLayoutDimensions(layout.id, settings.screenGap);

  document.body.dataset.theme = settings.theme;
  document.body.dataset.filter = settings.filter;
  document.body.dataset.layout = layout.id;

  // Keep canvas container exact aspect ratio (including hinge gap) so touch coordinates map 1:1
  screenViewport.style.aspectRatio = `${dims.width} / ${dims.height}`;
  screenStage.dataset.layout = layout.id;

  // Position visual DS hinge bar precisely over the gap between top & bottom screens
  if (dsHingeGap) {
    if (dims.gap > 0 && layout.id === 'top-bottom') {
      const gapPct = (dims.gap / dims.height) * 100;
      dsHingeGap.style.height = `${gapPct}%`;
      dsHingeGap.classList.remove('hidden');
    } else {
      dsHingeGap.classList.add('hidden');
    }
  }

  selectCore.value = settings.core;
  selectLayout.value = layout.id;
  selectGap.value = String(settings.screenGap ?? 36);
  selectFrameskip.value = String(settings.frameskip);
  selectFilter.value = settings.filter;
  toggleVibrate.checked = settings.vibrate;
  toggleTouchRipple.checked = settings.touchRipple;
  selectFfSpeed.value = String(settings.ffSpeed);
  controller.setVibrate(settings.vibrate);

  const scale = Number(settings.padScale) || 100;
  const offset = Number(settings.deckOffset) || 0;
  document.documentElement.style.setProperty('--pad-scale', String(scale / 100));
  document.documentElement.style.setProperty('--deck-offset', `${offset}px`);
  rangePadScale.value = String(scale);
  valPadScale.textContent = `${scale}%`;
  rangeDeckOffset.value = String(offset);
  valDeckOffset.textContent = `${offset > 0 ? '+' : ''}${offset}px`;

  btnLayoutCycle.querySelector('.hinge-btn-label').textContent = layout.shortLabel;
  btnFastForward.querySelector('.hinge-btn-label').textContent = `${settings.ffSpeed}x`;

  themePicker.querySelectorAll('.theme-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.theme === settings.theme);
  });
}

async function refreshResumeButton() {
  try {
    const roms = await listRoms();
    latestRomMeta = roms[0] || null;
    if (latestRomMeta) {
      btnResumeLast.textContent = `▶ ${latestRomMeta.name}`;
      btnResumeLast.classList.remove('hidden');
    } else {
      btnResumeLast.classList.add('hidden');
    }
  } catch {
    btnResumeLast.classList.add('hidden');
  }
}

async function refreshStorageStatus() {
  const info = await requestPersistentStorage();
  if (!info.supported) {
    storageStatusEl.textContent = 'このブラウザでは永続ストレージAPI非対応です（.sav書き出しでバックアップ推奨）。';
    return;
  }
  const usageText = info.usageMB !== null ? ` / 使用容量: 約 ${info.usageMB} MB` : '';
  storageStatusEl.textContent = info.persisted
    ? `ストレージ保護: 有効（自動削除されにくい状態${usageText}）。初回起動後はオフラインでも遊べます。`
    : `ストレージ保護: 標準（HTTPSでホーム画面に追加すると保護が強化されます${usageText}）。`;
}

function updateRunningUI() {
  const running = emulator.isRunning;
  bootOverlay.classList.toggle('hidden', running);
  ledPower.classList.toggle('on', running);
  ledStatus.classList.toggle('on', running && emulator.isFastForward);

  btnQuickSave.disabled = !running;
  btnQuickLoad.disabled = !running;
  btnFastForward.disabled = !running;
  btnMute.disabled = !running;

  btnPauseResume.disabled = !running;
  btnRestart.disabled = !running;
  btnExitGame.disabled = !running;
  btnExportSav.disabled = !running;
  btnImportSav.disabled = !running;

  btnFastForward.classList.toggle('active', running && emulator.isFastForward);
  btnMute.classList.toggle('active', running && emulator.isMuted);
  btnMute.querySelector('.hinge-btn-label').textContent = emulator.isMuted ? 'MUTE' : 'SFX';
  btnPauseResume.textContent = emulator.isPaused ? '再開' : '一時停止';
}

/* ---------- ROM Launching & Seamless Reload ---------- */
async function launchRomById(romId, { preserveState = false } = {}) {
  closeModal(modalLibrary);
  closeModal(modalMenu);

  let tempStateBlob = null;
  if (preserveState && emulator.isRunning && emulator.currentCore === settings.core) {
    try {
      setLoading(true, '画面レイアウトを切替中...');
      const snap = await emulator.saveState();
      tempStateBlob = snap.state;
    } catch {
      tempStateBlob = null;
    }
  }

  setLoading(true, 'ROMデータを読み込み中...');
  try {
    const romRecord = await getRom(romId);
    if (!romRecord) {
      throw new Error('ROMデータが見つかりませんでした');
    }
    await touchRom(romRecord.id);
    const [sramBlob, biosFiles] = await Promise.all([
      loadSram(romRecord.id),
      loadAllBiosFiles()
    ]);

    await emulator.launch(romRecord, sramBlob, {
      core: settings.core,
      screenLayout: settings.screenLayout,
      screenGap: settings.screenGap,
      frameskip: settings.frameskip,
      ffSpeed: settings.ffSpeed,
      biosFiles,
      initialStateBlob: tempStateBlob
    });

    updateRunningUI();
    const coreInfo = getCoreInfo(settings.core);
    showToast(
      tempStateBlob
        ? `画面モード: ${getLayoutInfo(settings.screenLayout).label}`
        : `${romRecord.name} を起動しました (${coreInfo.name})`
    );
  } catch (err) {
    console.error(err);
    showToast(`起動失敗: ${err.message || err}`, 4500);
    await emulator.exit();
    updateRunningUI();
  } finally {
    setLoading(false);
  }
}

async function handleRomFileSelected(file) {
  if (!file) return;
  setLoading(true, 'DS ROMを解析・保存中...（容量が大きい場合は数秒かかります）');
  try {
    const record = await saveRom(file);
    await refreshResumeButton();
    await launchRomById(record.id);
  } catch (err) {
    console.error(err);
    showToast(err.message || 'ROMの読み込みに失敗しました', 3500);
    setLoading(false);
  }
}

/* ---------- Library Rendering ---------- */
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function renderLibrary() {
  const roms = await listRoms();
  if (roms.length === 0) {
    romListEl.innerHTML = '<p class="empty-msg">保存されたDS ROMはまだありません</p>';
    return;
  }

  romListEl.innerHTML = '';
  for (const rom of roms) {
    const item = document.createElement('div');
    item.className = 'rom-item';

    const info = document.createElement('div');
    info.className = 'rom-info';
    info.innerHTML = `
      <div class="rom-name-row">
        <span class="sys-badge">NDS</span>
        <div class="rom-name"></div>
      </div>
      <div class="rom-meta">${formatSize(rom.size)} ・ ${formatDate(rom.updatedAt)}</div>
    `;
    info.querySelector('.rom-name').textContent = rom.name;
    info.addEventListener('click', () => launchRomById(rom.id));

    const actions = document.createElement('div');
    actions.className = 'rom-actions';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'rom-btn-play';
    playBtn.textContent = '起動';
    playBtn.addEventListener('click', () => launchRomById(rom.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'rom-btn-del';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`「${rom.name}」と関連するセーブデータを削除しますか？`)) return;
      if (emulator.currentRom?.id === rom.id) {
        await emulator.exit();
        updateRunningUI();
      }
      await deleteRom(rom.id);
      await renderLibrary();
      await refreshResumeButton();
      await refreshStorageStatus();
      showToast('削除しました');
    });

    actions.append(playBtn, delBtn);
    item.append(info, actions);
    romListEl.append(item);
  }
}

/* ---------- Save State Slots Rendering ---------- */
async function renderStateSlots() {
  stateSlotsEl.innerHTML = '';
  if (!emulator.currentRom) {
    stateSlotsEl.innerHTML = '<p class="empty-msg">ゲーム起動中にステートセーブが利用できます</p>';
    return;
  }

  const slots = await getStateSlotsMeta(emulator.currentRom.id);
  for (const s of slots) {
    const row = document.createElement('div');
    row.className = 'slot-row';

    const img = document.createElement('img');
    img.className = 'slot-thumb';
    img.alt = `スロット${s.slot}`;
    if (s.thumbnail) {
      img.src = s.thumbnail;
    }

    const info = document.createElement('div');
    info.className = 'slot-info';
    info.innerHTML = `
      <div class="slot-title">スロット ${s.slot}${s.slot === 1 ? ' (クイック)' : ''}</div>
      <div class="slot-time">${s.exists ? formatDate(s.updatedAt) : '空きスロット'}</div>
    `;

    const btns = document.createElement('div');
    btns.className = 'slot-btns';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'slot-btn slot-btn-save';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', async () => {
      await doSaveState(s.slot);
      await renderStateSlots();
    });

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'slot-btn';
    loadBtn.textContent = '復元';
    loadBtn.disabled = !s.exists;
    loadBtn.addEventListener('click', async () => {
      await doLoadState(s.slot);
      closeModal(modalMenu);
    });

    btns.append(saveBtn, loadBtn);
    row.append(img, info, btns);
    stateSlotsEl.append(row);
  }
}

/* ---------- BIOS List Rendering ---------- */
async function renderBiosList() {
  const list = await listBiosMeta();
  biosListEl.innerHTML = '';
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'bios-row';
    row.innerHTML = `
      <span class="bios-name">${b.name}</span>
      <span class="bios-status ${b.exists ? 'ok' : ''}">${b.exists ? `登録済 (${formatSize(b.size)})` : '未登録'}</span>
    `;
    if (b.exists) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bios-del-btn';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        await deleteBiosFile(b.name);
        await renderBiosList();
        showToast(`${b.name} を削除しました`);
      });
      row.append(delBtn);
    }
    biosListEl.append(row);
  }
}

async function doSaveState(slot) {
  if (!emulator.isRunning || !emulator.currentRom) return;
  try {
    ledStatus.classList.add('on');
    const { state, thumbnail } = await emulator.saveState();
    await saveStateSlot(emulator.currentRom.id, slot, state, thumbnail);
    showToast(`スロット ${slot} に保存しました`);
  } catch (err) {
    console.error(err);
    showToast('ステートセーブに失敗しました');
  } finally {
    ledStatus.classList.toggle('on', emulator.isFastForward);
  }
}

async function doLoadState(slot) {
  if (!emulator.isRunning || !emulator.currentRom) return;
  try {
    const data = await loadStateSlot(emulator.currentRom.id, slot);
    if (!data) {
      showToast(`スロット ${slot} にデータがありません`);
      return;
    }
    await emulator.loadState(data.state);
    showToast(`スロット ${slot} を復元しました`);
  } catch (err) {
    console.error(err);
    showToast('ステートロードに失敗しました');
  }
}

/* ---------- Event Listeners ---------- */
btnResumeLast.addEventListener('click', () => {
  if (latestRomMeta) launchRomById(latestRomMeta.id);
});

btnPickRomMain.addEventListener('click', () => romFileInput.click());
btnAddRom.addEventListener('click', () => romFileInput.click());
romFileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  handleRomFileSelected(file);
});

btnOpenLibraryMain.addEventListener('click', async () => {
  await renderLibrary();
  openModal(modalLibrary);
});

btnLibrary.addEventListener('click', async () => {
  await renderLibrary();
  openModal(modalLibrary);
});

btnMenu.addEventListener('click', async () => {
  await Promise.all([renderStateSlots(), renderBiosList(), refreshStorageStatus()]);
  openModal(modalMenu);
});

document.querySelectorAll('[data-close-modal]').forEach((el) => {
  el.addEventListener('click', () => {
    const target = document.getElementById(el.dataset.closeModal);
    if (target) closeModal(target);
  });
});

// Hinge quick buttons
btnQuickSave.addEventListener('click', () => doSaveState(1));
btnQuickLoad.addEventListener('click', () => doLoadState(1));

btnLayoutCycle.addEventListener('click', async () => {
  const idx = LAYOUT_CYCLE_ORDER.indexOf(settings.screenLayout);
  const nextLayout = LAYOUT_CYCLE_ORDER[(idx + 1) % LAYOUT_CYCLE_ORDER.length];
  settings = saveSettings({ screenLayout: nextLayout });
  applySettings();
  if (emulator.isRunning && emulator.currentRom) {
    await launchRomById(emulator.currentRom.id, { preserveState: true });
  } else {
    showToast(`画面モード: ${getLayoutInfo(nextLayout).label}`);
  }
});

btnFastForward.addEventListener('click', () => {
  const on = emulator.toggleFastForward();
  updateRunningUI();
  showToast(on ? `倍速 ON (${settings.ffSpeed}x)` : '倍速 OFF');
});

btnMute.addEventListener('click', () => {
  const muted = emulator.toggleMute();
  updateRunningUI();
  showToast(muted ? 'ミュート ON' : '音声 ON');
});

// Menu game controls
btnPauseResume.addEventListener('click', async () => {
  const paused = await emulator.togglePause();
  updateRunningUI();
  showToast(paused ? '一時停止中' : '再開しました');
});

btnRestart.addEventListener('click', async () => {
  await emulator.restart();
  updateRunningUI();
  closeModal(modalMenu);
  showToast('リセットしました');
});

btnExitGame.addEventListener('click', async () => {
  await emulator.exit();
  updateRunningUI();
  await refreshResumeButton();
  closeModal(modalMenu);
  showToast('セーブを保存して終了しました');
});

btnFullscreen.addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    showToast('このブラウザでは全画面切替に対応していません');
  }
});

// Export / Import .sav (SRAM)
btnExportSav.addEventListener('click', async () => {
  if (!emulator.currentRom) return;
  const sram = (await emulator.flushSram()) || (await loadSram(emulator.currentRom.id));
  if (!sram) {
    showToast('書き出すセーブデータがまだありません');
    return;
  }
  const url = URL.createObjectURL(sram);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${emulator.currentRom.name}.sav`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`${emulator.currentRom.name}.sav を書き出しました`);
});

btnImportSav.addEventListener('click', () => savFileInput.click());
savFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !emulator.currentRom) return;
  const romId = emulator.currentRom.id;
  await saveSram(romId, file);
  showToast('.sav を読み込みました（再起動します）');
  await launchRomById(romId);
});

// Optional BIOS upload
btnAddBios.addEventListener('click', () => biosFileInput.click());
biosFileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;
  let count = 0;
  for (const f of files) {
    try {
      await saveBiosFile(f);
      count++;
    } catch (err) {
      showToast(err.message, 3000);
    }
  }
  if (count > 0) {
    await renderBiosList();
    showToast(`BIOSファイルを ${count} 件登録しました`);
  }
});

// Settings controls
themePicker.addEventListener('click', (e) => {
  const chip = e.target.closest('.theme-chip');
  if (!chip) return;
  settings = saveSettings({ theme: chip.dataset.theme });
  applySettings();
});

selectCore.addEventListener('change', async () => {
  settings = saveSettings({ core: selectCore.value });
  applySettings();
  if (emulator.isRunning && emulator.currentRom) {
    showToast(`${getCoreInfo(settings.core).name} で再起動します...`);
    await launchRomById(emulator.currentRom.id);
  } else {
    showToast(`コアを ${getCoreInfo(settings.core).name} に変更しました`);
  }
});

selectLayout.addEventListener('change', async () => {
  settings = saveSettings({ screenLayout: selectLayout.value });
  applySettings();
  if (emulator.isRunning && emulator.currentRom) {
    await launchRomById(emulator.currentRom.id, { preserveState: true });
  }
});

selectGap.addEventListener('change', async () => {
  settings = saveSettings({ screenGap: Number(selectGap.value) });
  applySettings();
  if (emulator.isRunning && emulator.currentRom) {
    await launchRomById(emulator.currentRom.id, { preserveState: true });
  } else {
    showToast('上下画面の隙間を変更しました');
  }
});

selectFrameskip.addEventListener('change', async () => {
  settings = saveSettings({ frameskip: Number(selectFrameskip.value) });
  applySettings();
  if (emulator.isRunning && emulator.currentRom) {
    await launchRomById(emulator.currentRom.id, { preserveState: true });
  } else {
    showToast(`フレームスキップ: ${settings.frameskip}`);
  }
});

selectFilter.addEventListener('change', () => {
  settings = saveSettings({ filter: selectFilter.value });
  applySettings();
});

toggleVibrate.addEventListener('change', () => {
  settings = saveSettings({ vibrate: toggleVibrate.checked });
  applySettings();
});

toggleTouchRipple.addEventListener('change', () => {
  settings = saveSettings({ touchRipple: toggleTouchRipple.checked });
  applySettings();
});

selectFfSpeed.addEventListener('change', () => {
  settings = saveSettings({ ffSpeed: Number(selectFfSpeed.value) });
  applySettings();
  showToast('次回起動時から倍速設定が反映されます');
});

rangePadScale.addEventListener('input', () => {
  settings = saveSettings({ padScale: Number(rangePadScale.value) });
  applySettings();
});

rangeDeckOffset.addEventListener('input', () => {
  settings = saveSettings({ deckOffset: Number(rangeDeckOffset.value) });
  applySettings();
});

btnResetLayout.addEventListener('click', () => {
  settings = saveSettings({ padScale: 100, deckOffset: 0 });
  applySettings();
  showToast('ボタン配置を初期値に戻しました');
});

// Auto-save SRAM when switching apps or locking screen on Android
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && emulator.isRunning) {
    emulator.flushSram().catch(() => {});
  }
});

// Init
applySettings();
updateRunningUI();
refreshResumeButton();
refreshStorageStatus();

