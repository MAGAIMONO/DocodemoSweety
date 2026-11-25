/**
 * Multi-touch Retro DS Virtual Controller + Keyboard + Bluetooth Gamepad
 * - 8-way slide D-Pad (angle & deadzone detection)
 * - 4-button X/Y/A/B diamond slide & simultaneous-press zone
 * - Shoulder L/R, START, SELECT, MIC (l3), and Lid Close (l2)
 * - Independent of canvas touch events so stylus input works simultaneously
 */

const KEY_MAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  KeyZ: 'b',
  KeyX: 'a',
  KeyC: 'y',
  KeyV: 'x',
  KeyK: 'b',
  KeyL: 'a',
  KeyJ: 'y',
  KeyI: 'x',
  KeyQ: 'l',
  KeyE: 'r',
  KeyM: 'l3',       // DS Microphone noise
  KeyU: 'l2',       // DS Lid close
  Enter: 'start',
  ShiftRight: 'select',
  ShiftLeft: 'select',
  Backspace: 'select'
};

export class DSController {
  constructor({ onPress, onRelease, vibrateEnabled = true }) {
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.vibrateEnabled = vibrateEnabled;

    this.sources = {
      touch: new Set(),
      keyboard: new Set(),
      gamepad: new Set()
    };
    this.activeButtons = new Set();

    this.dpadPointers = new Map();
    this.abxyPointers = new Map();
    this.simplePointers = new Map();

    this.dpadZone = document.getElementById('dpad-zone');
    this.abxyZone = document.getElementById('abxy-zone');
    this.btnA = document.querySelector('.btn-a');
    this.btnB = document.querySelector('.btn-b');
    this.btnX = document.querySelector('.btn-x');
    this.btnY = document.querySelector('.btn-y');

    this._rafId = null;
    this._bindTouchControls();
    this._bindKeyboard();
    this._startGamepadPolling();
  }

  setVibrate(enabled) {
    this.vibrateEnabled = Boolean(enabled);
  }

  _vibrate() {
    if (this.vibrateEnabled && navigator.vibrate) {
      try {
        navigator.vibrate(10);
      } catch {
        // ignore
      }
    }
  }

  _syncButtons() {
    const next = new Set();
    for (const set of Object.values(this.sources)) {
      for (const btn of set) next.add(btn);
    }

    for (const btn of next) {
      if (!this.activeButtons.has(btn)) {
        this.activeButtons.add(btn);
        this._setVisualState(btn, true);
        this._vibrate();
        this.onPress?.(btn);
      }
    }

    for (const btn of Array.from(this.activeButtons)) {
      if (!next.has(btn)) {
        this.activeButtons.delete(btn);
        this._setVisualState(btn, false);
        this.onRelease?.(btn);
      }
    }
  }

  _rebuildTouchSource() {
    const set = new Set();
    for (const dirs of this.dpadPointers.values()) {
      for (const d of dirs) set.add(d);
    }
    for (const btns of this.abxyPointers.values()) {
      for (const b of btns) set.add(b);
    }
    for (const btn of this.simplePointers.values()) {
      set.add(btn);
    }
    this.sources.touch = set;
    this._syncButtons();
  }

  _setVisualState(button, pressed) {
    if (['up', 'down', 'left', 'right'].includes(button)) {
      const arm = document.querySelector(`.dpad-arm[data-dir="${button}"]`);
      if (arm) arm.classList.toggle('pressed', pressed);
      return;
    }
    document.querySelectorAll(`[data-button="${button}"]`).forEach((el) => {
      el.classList.toggle('pressed', pressed);
    });
  }

  _computeDpadDirs(clientX, clientY) {
    const rect = this.dpadZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);

    if (dist < 11) return new Set();

    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const dirs = new Set();
    if (deg >= -157.5 && deg <= -22.5) dirs.add('up');
    if (deg >= 22.5 && deg <= 157.5) dirs.add('down');
    if (deg >= -67.5 && deg <= 67.5) dirs.add('right');
    if (deg <= -112.5 || deg >= 112.5) dirs.add('left');
    return dirs;
  }

  _computeAbxyButtons(clientX, clientY) {
    const targets = [
      { name: 'a', el: this.btnA },
      { name: 'b', el: this.btnB },
      { name: 'x', el: this.btnX },
      { name: 'y', el: this.btnY }
    ];

    const measured = [];
    for (const t of targets) {
      if (!t.el) continue;
      const rect = t.el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      measured.push({
        name: t.name,
        dist: Math.hypot(clientX - cx, clientY - cy),
        width: rect.width
      });
    }

    if (measured.length === 0) return new Set();

    const hitRadius = Math.max(measured[0].width, 38) * 0.72;
    const btns = new Set();
    for (const m of measured) {
      if (m.dist <= hitRadius) btns.add(m.name);
    }

    if (btns.size === 0) {
      measured.sort((a, b) => a.dist - b.dist);
      if (measured[0].dist < hitRadius * 1.45) {
        btns.add(measured[0].name);
      }
    }

    return btns;
  }

  _bindTouchControls() {
    if (this.dpadZone) {
      const updateDpad = (e) => {
        e.preventDefault();
        this.dpadPointers.set(e.pointerId, this._computeDpadDirs(e.clientX, e.clientY));
        this._rebuildTouchSource();
      };
      const releaseDpad = (e) => {
        if (this.dpadPointers.delete(e.pointerId)) {
          this._rebuildTouchSource();
        }
      };

      this.dpadZone.addEventListener('pointerdown', (e) => {
        this.dpadZone.setPointerCapture(e.pointerId);
        updateDpad(e);
      });
      this.dpadZone.addEventListener('pointermove', (e) => {
        if (this.dpadPointers.has(e.pointerId)) updateDpad(e);
      });
      this.dpadZone.addEventListener('pointerup', releaseDpad);
      this.dpadZone.addEventListener('pointercancel', releaseDpad);
    }

    if (this.abxyZone) {
      const updateAbxy = (e) => {
        e.preventDefault();
        this.abxyPointers.set(e.pointerId, this._computeAbxyButtons(e.clientX, e.clientY));
        this._rebuildTouchSource();
      };
      const releaseAbxy = (e) => {
        if (this.abxyPointers.delete(e.pointerId)) {
          this._rebuildTouchSource();
        }
      };

      this.abxyZone.addEventListener('pointerdown', (e) => {
        this.abxyZone.setPointerCapture(e.pointerId);
        updateAbxy(e);
      });
      this.abxyZone.addEventListener('pointermove', (e) => {
        if (this.abxyPointers.has(e.pointerId)) updateAbxy(e);
      });
      this.abxyZone.addEventListener('pointerup', releaseAbxy);
      this.abxyZone.addEventListener('pointercancel', releaseAbxy);
    }

    const simpleBtns = document.querySelectorAll(
      '[data-button="l"], [data-button="r"], [data-button="start"], [data-button="select"], [data-button="l3"], [data-button="l2"]'
    );
    simpleBtns.forEach((el) => {
      const btnName = el.dataset.button;
      const release = (e) => {
        if (this.simplePointers.delete(e.pointerId)) {
          this._rebuildTouchSource();
        }
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.simplePointers.set(e.pointerId, btnName);
        this._rebuildTouchSource();
      });
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    });
  }

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const mapped = KEY_MAP[e.code];
      if (!mapped) return;
      e.preventDefault();
      if (!this.sources.keyboard.has(mapped)) {
        this.sources.keyboard.add(mapped);
        this._syncButtons();
      }
    });

    window.addEventListener('keyup', (e) => {
      const mapped = KEY_MAP[e.code];
      if (!mapped) return;
      if (this.sources.keyboard.delete(mapped)) {
        this._syncButtons();
      }
    });

    window.addEventListener('blur', () => {
      this.sources.keyboard.clear();
      this.dpadPointers.clear();
      this.abxyPointers.clear();
      this.simplePointers.clear();
      this.sources.touch.clear();
      this._syncButtons();
    });
  }

  _startGamepadPolling() {
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = pads && Array.from(pads).find((p) => p && p.connected);
      const next = new Set();

      if (pad) {
        const pressed = (idx) => Boolean(pad.buttons[idx]?.pressed);
        if (pressed(0)) next.add('b');
        if (pressed(1)) next.add('a');
        if (pressed(2)) next.add('y');
        if (pressed(3)) next.add('x');
        if (pressed(4)) next.add('l');
        if (pressed(5)) next.add('r');
        if (pressed(6)) next.add('l2'); // Lid close
        if (pressed(10)) next.add('l3'); // Mic
        if (pressed(8)) next.add('select');
        if (pressed(9)) next.add('start');
        if (pressed(12) || (pad.axes[1] ?? 0) < -0.45) next.add('up');
        if (pressed(13) || (pad.axes[1] ?? 0) > 0.45) next.add('down');
        if (pressed(14) || (pad.axes[0] ?? 0) < -0.45) next.add('left');
        if (pressed(15) || (pad.axes[0] ?? 0) > 0.45) next.add('right');
      }

      const prev = this.sources.gamepad;
      let changed = next.size !== prev.size;
      if (!changed) {
        for (const b of next) {
          if (!prev.has(b)) { changed = true; break; }
        }
      }
      if (changed) {
        this.sources.gamepad = next;
        this._syncButtons();
      }

      this._rafId = requestAnimationFrame(poll);
    };
    this._rafId = requestAnimationFrame(poll);
  }
}

