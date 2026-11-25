/**
 * Nintendo DS Web Emulator Wrapper powered by EmulatorJS (cdn.emulatorjs.org)
 * Runs inside an isolated same-origin iframe (`ejs-host.html`) so ROM switching,
 * core switching, and exit cleanly release WASM/WebGL/Audio resources.
 * Supports DeSmuME 2015, DeSmuME, and melonDS with direct touch screen input.
 */

import { saveSram } from './storage.js';

export const DS_CORES = {
  desmume2015: {
    id: 'desmume2015',
    name: 'DeSmuME 2015',
    desc: '軽量・BIOS不要（スマホ推奨）'
  },
  desmume: {
    id: 'desmume',
    name: 'DeSmuME',
    desc: '標準・BIOS不要'
  },
  melonds: {
    id: 'melonds',
    name: 'melonDS',
    desc: '高精度（BIOS登録推奨）'
  }
};

export const SCREEN_LAYOUTS = {
  'top-bottom': {
    id: 'top-bottom',
    label: '上下標準',
    shortLabel: '上下',
    width: 256,
    height: 384,
    desmume: 'top/bottom',
    melonds: 'Top/Bottom'
  },
  'left-right': {
    id: 'left-right',
    label: '左右並び',
    shortLabel: '左右',
    width: 512,
    height: 192,
    desmume: 'left/right',
    melonds: 'Left/Right'
  },
  'hybrid-top': {
    id: 'hybrid-top',
    label: '上画面メイン',
    shortLabel: '上大',
    width: 768,
    height: 384,
    desmume: 'hybrid/top',
    melonds: 'Hybrid Top'
  },
  'hybrid-bottom': {
    id: 'hybrid-bottom',
    label: '下画面メイン',
    shortLabel: '下大',
    width: 768,
    height: 384,
    desmume: 'hybrid/bottom',
    melonds: 'Hybrid Bottom'
  },
  'top-only': {
    id: 'top-only',
    label: '上画面のみ',
    shortLabel: '上単',
    width: 256,
    height: 192,
    desmume: 'top only',
    melonds: 'Top Only'
  },
  'bottom-only': {
    id: 'bottom-only',
    label: '下画面のみ',
    shortLabel: '下単',
    width: 256,
    height: 192,
    desmume: 'bottom only',
    melonds: 'Bottom Only'
  }
};

// Libretro RetroPad button indices used by EmulatorJS `simulateInput(player, id, value)`
const BUTTON_TO_RETROPAD = {
  b: 0,
  y: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  a: 8,
  x: 9,
  l: 10,
  r: 11,
  l2: 12,
  r2: 13,
  l3: 14,
  r3: 15
};

export function getLayoutInfo(layoutId) {
  return SCREEN_LAYOUTS[layoutId] || SCREEN_LAYOUTS['top-bottom'];
}

export function getLayoutDimensions(layoutId, screenGap = 36) {
  const info = getLayoutInfo(layoutId);
  const gap = Math.max(0, Math.min(96, Number(screenGap) || 0));
  if (info.id === 'top-bottom') {
    return { width: info.width, height: info.height + gap, gap };
  }
  return { width: info.width, height: info.height, gap: 0 };
}

export function getCoreInfo(coreId) {
  return DS_CORES[coreId] || DS_CORES.desmume2015;
}

export class RetroDSEmulator {
  constructor({ canvas, onStatus, onCanvasReplaced }) {
    this.canvas = canvas;
    this.viewport = canvas ? canvas.parentElement : document.getElementById('screen-viewport');
    this.onStatus = onStatus;
    this.onCanvasReplaced = onCanvasReplaced;
    this.iframe = null;
    this.ejs = null;
    this.romObjectUrl = null;
    this.currentRom = null;
    this.currentCore = 'desmume2015';
    this.currentLayout = 'top-bottom';
    this.ffSpeed = 2;
    this.isPaused = false;
    this.isFastForward = false;
    this.isMuted = false;
    this.autoSaveTimer = null;
  }

  get isRunning() {
    return Boolean(this.ejs && this.ejs.gameManager);
  }

  _detectWebGL() {
    const probe = document.createElement('canvas');
    if (probe.getContext('webgl2')) return 'webgl2';
    if (probe.getContext('webgl') || probe.getContext('experimental-webgl')) return 'webgl1';
    return 'none';
  }

  _buildDefaultOptions(coreId, layoutInfo, frameskip, screenGap = 36) {
    const fs = String(Math.max(0, Math.min(3, Number(frameskip) || 0)));
    const gap = String(Math.max(0, Math.min(90, Number(screenGap) || 0)));

    if (coreId === 'melonds') {
      return {
        melonds_touch_mode: 'Touch',
        melonds_screen_layout: layoutInfo.melonds,
        melonds_screen_gap: gap,
        melonds_boot_directly: 'enabled',
        melonds_jit_enable: 'disabled',
        melonds_threaded_renderer: 'disabled'
      };
    }

    return {
      desmume_pointer_type: 'touch',
      desmume_pointer_mouse: 'enabled',
      desmume_screens_layout: layoutInfo.desmume,
      desmume_screens_gap: gap,
      desmume_frameskip: fs,
      desmume_internal_resolution: '256x192',
      desmume_cpu_mode: 'interpreter',
      desmume_mic_mode: 'internal',
      desmume_num_cores: '1'
    };
  }

  async launch(
    romRecord,
    initialSramBlob = null,
    {
      core = 'desmume2015',
      screenLayout = 'top-bottom',
      screenGap = 36,
      frameskip = 1,
      ffSpeed = 2,
      biosFiles = [],
      initialStateBlob = null
    } = {}
  ) {
    await this.exit();

    const glSupport = this._detectWebGL();
    if (glSupport === 'none') {
      throw new Error(
        'このブラウザでWebGLが無効になっています。Chromeの設定で「グラフィック アクセラレーション」をONにして再起動するか、スマホから開いてお試しください。'
      );
    }

    const coreInfo = getCoreInfo(core);
    const layoutInfo = getLayoutInfo(screenLayout);
    this.ffSpeed = Number(ffSpeed) || 2;

    this.onStatus?.(`${coreInfo.name} コアを準備中...`);

    const romBlob = new Blob([romRecord.data], { type: 'application/octet-stream' });
    this.romObjectUrl = URL.createObjectURL(romBlob);

    const initialSram = initialSramBlob
      ? new Uint8Array(await initialSramBlob.arrayBuffer())
      : null;

    const initialState = initialStateBlob
      ? new Uint8Array(await initialStateBlob.arrayBuffer())
      : null;

    const preparedBios = [];
    for (const b of biosFiles || []) {
      const bytes = new Uint8Array(await b.fileContent.arrayBuffer());
      preparedBios.push({ fileName: b.fileName, bytes });
    }

    // Create isolated same-origin iframe inside screen viewport
    const iframe = document.createElement('iframe');
    iframe.className = 'ejs-frame';
    iframe.src = './ejs-host.html';
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad');

    if (this.canvas) {
      this.canvas.style.display = 'none';
    }
    this.viewport.prepend(iframe);
    this.iframe = iframe;

    await new Promise((resolve, reject) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.addEventListener('error', () => reject(new Error('コアホストの読み込みに失敗しました')), { once: true });
    });

    this.onStatus?.(`[DS] ${romRecord.name} を起動中...`);

    const defaultOptions = this._buildDefaultOptions(coreInfo.id, layoutInfo, frameskip, screenGap);
    const ejs = await iframe.contentWindow.bootEJS({
      core: coreInfo.id,
      gameName: romRecord.name,
      romUrl: this.romObjectUrl,
      defaultOptions,
      initialSram,
      initialState,
      biosFiles: preparedBios
    });

    this.ejs = ejs;
    this.currentRom = {
      id: romRecord.id,
      name: romRecord.name,
      fileName: romRecord.fileName,
      size: romRecord.size
    };
    this.currentCore = coreInfo.id;
    this.currentLayout = layoutInfo.id;
    this.isPaused = false;
    this.isFastForward = false;
    this.isMuted = false;

    try {
      this.ejs.gameManager.setFastForwardRatio(this.ffSpeed);
    } catch {
      // ignore
    }

    // Bind stylus visual indicator to the inner EmulatorJS canvas
    const innerCanvas = iframe.contentDocument?.querySelector('canvas');
    if (innerCanvas) {
      this.onCanvasReplaced?.(innerCanvas);
    }

    // Periodic SRAM auto-save every 20 seconds
    this.autoSaveTimer = setInterval(() => {
      this.flushSram().catch(() => {});
    }, 20000);
  }

  pressDown(button) {
    if (!this.isRunning || this.isPaused) return;
    const id = BUTTON_TO_RETROPAD[button];
    if (id === undefined) return;
    try {
      this.ejs.gameManager.simulateInput(0, id, 1);
    } catch {
      // ignore
    }
  }

  pressUp(button) {
    if (!this.isRunning) return;
    const id = BUTTON_TO_RETROPAD[button];
    if (id === undefined) return;
    try {
      this.ejs.gameManager.simulateInput(0, id, 0);
    } catch {
      // ignore
    }
  }

  async flushSram() {
    if (!this.isRunning || !this.currentRom) return null;
    try {
      const data = this.ejs.gameManager.getSaveFile(true);
      if (data && data.byteLength > 0) {
        const blob = new Blob([data]);
        await saveSram(this.currentRom.id, blob);
        return blob;
      }
    } catch {
      // ignore if game has not written SRAM yet
    }
    return null;
  }

  async saveState() {
    if (!this.isRunning) throw new Error('ゲームが起動していません');
    const stateBytes = this.ejs.gameManager.getState();
    const stateBlob = new Blob([stateBytes]);

    let thumbnail = '';
    try {
      const innerCanvas = this.iframe?.contentDocument?.querySelector('canvas');
      if (innerCanvas) {
        thumbnail = innerCanvas.toDataURL('image/png');
      }
    } catch {
      // ignore if canvas tainted
    }

    return {
      state: stateBlob,
      thumbnail
    };
  }

  async loadState(stateBlob) {
    if (!this.isRunning) throw new Error('ゲームが起動していません');
    const bytes = new Uint8Array(await stateBlob.arrayBuffer());
    this.ejs.gameManager.loadState(bytes);
  }

  toggleFastForward() {
    if (!this.isRunning) return false;
    this.isFastForward = !this.isFastForward;
    try {
      this.ejs.gameManager.setFastForwardRatio(this.ffSpeed);
      this.ejs.gameManager.toggleFastForward(this.isFastForward ? 1 : 0);
    } catch {
      this.isFastForward = !this.isFastForward;
    }
    return this.isFastForward;
  }

  toggleMute() {
    if (!this.isRunning) return false;
    this.isMuted = !this.isMuted;
    try {
      if (typeof this.ejs.setVolume === 'function') {
        this.ejs.setVolume(this.isMuted ? 0 : 1);
      } else {
        this.ejs.muted = this.isMuted;
      }
    } catch {
      this.isMuted = !this.isMuted;
    }
    return this.isMuted;
  }

  async togglePause() {
    if (!this.isRunning) return false;
    if (this.isPaused) {
      this.ejs.gameManager.toggleMainLoop(1);
      this.isPaused = false;
    } else {
      await this.flushSram();
      this.ejs.gameManager.toggleMainLoop(0);
      this.isPaused = true;
    }
    return this.isPaused;
  }

  async restart() {
    if (!this.isRunning) return;
    await this.flushSram();
    this.ejs.gameManager.restart();
    this.isPaused = false;
  }

  async exit() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.isRunning) {
      try {
        await this.flushSram();
      } catch {
        // ignore
      }
      try {
        this.ejs.gameManager.toggleMainLoop(0);
      } catch {
        // ignore
      }
    }
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    if (this.romObjectUrl) {
      URL.revokeObjectURL(this.romObjectUrl);
      this.romObjectUrl = null;
    }
    if (this.canvas) {
      this.canvas.style.display = 'block';
    }
    this.ejs = null;
    this.currentRom = null;
    this.isPaused = false;
    this.isFastForward = false;
    this.isMuted = false;
  }
}
