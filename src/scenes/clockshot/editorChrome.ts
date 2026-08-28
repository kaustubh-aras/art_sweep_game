import type Phaser from 'phaser';
import { esc, mountForScene, type UiScreen } from '@/clockshot/uiLayer';
import { dpr } from '@/ui/viewport';
import '@/clockshot/editor.css';

/**
 * The level editor's chrome: the toolbar, the tool rail, and the dialogs.
 *
 * Everything here used to be drawn on the canvas — nine buttons that were bare
 * glyphs (`‹`, `≡`, `↶`, `↷`, `#`) with hit rectangles registered by hand, a
 * rail with its own scroll arithmetic and a geometry mask, and a rename that
 * called `window.prompt`. In a Reddit web view `window.prompt` is blocked
 * outright, so renaming a level was not merely awkward there: it was
 * impossible, and the editor said so in a toast.
 *
 * As DOM it is buttons, a scrolling list and a dialog. That fixes the rename,
 * gives every control a real 48px target with a focus ring and a disabled
 * state, and lets `aria-pressed` say out loud what ERASE and PAINT are doing —
 * none of which a canvas can express.
 *
 * The *level surface* stays on the canvas, which is what a canvas is for. This
 * module only reports how much room it has taken so the scene can lay the grid
 * out in what is left.
 */

/** What the chrome needs to know to paint itself. */
export interface ChromeState {
  name: string;
  tools: readonly ChromeTool[];
  /** The selected tool, or null while the eraser is active. */
  tool: string | null;
  canUndo: boolean;
  canRedo: boolean;
  showGrid: boolean;
  erase: boolean;
  /** True when a drag paints; false when it slides the view. */
  paintMode: boolean;
  used: number;
  total: number;
  /** A level only becomes postable once its author has actually cleared it. */
  verified: boolean;
  /** Set while a publish is in flight, so the button cannot be pressed twice. */
  publishing?: boolean;
}

export interface ChromeTool {
  id: string;
  label: string;
  /** The line under the label: a count and a cost, or what the marker is for. */
  sub: string;
  /** Hex colour for the swatch, as a CSS string. */
  colour: string;
  /** Out of budget, or already at its cap. */
  disabled: boolean;
}

export interface ChromeHandlers {
  onAction(id: string): void;
  onTool(id: string): void;
  onRename(name: string): void;
}

export interface EditorChrome {
  update(state: ChromeState): void;
  toast(message: string, ms?: number): void;
  /**
   * Asks the builder to confirm the name their level goes out under.
   *
   * Posting is the one irreversible thing the editor does: the level becomes a
   * Reddit post other people play, and the name on it is the name it keeps.
   * Resolves true to go ahead, false if they backed out.
   */
  confirmPost(name: string): Promise<boolean>;
  /** The space the chrome occupies, in GAME UNITS, for the scene's layout. */
  insets(): { top: number; left: number };
  destroy(): void;
}

/** The toolbar, left to right. Icons are drawn, never emoji or font glyphs. */
const ACTIONS: readonly { id: string; label: string; icon: string; title: string }[] = [
  { id: 'back', label: '', icon: 'back', title: 'Back' },
  { id: 'undo', label: '', icon: 'undo', title: 'Undo' },
  { id: 'redo', label: '', icon: 'redo', title: 'Redo' },
  { id: 'grid', label: '', icon: 'grid', title: 'Show the grid' },
];

/**
 * Inline SVG, so the icons are shapes rather than characters.
 *
 * A glyph like `↶` depends on the platform having it and renders at whatever
 * weight the font feels like. These are 1.5px strokes on a 24px box, which is
 * one stroke weight across the whole toolbar.
 */
function icon(name: string): string {
  const paths: Record<string, string> = {
    back: '<path d="M15 5 L8 12 L15 19"/>',
    undo: '<path d="M9 8H15a4 4 0 0 1 0 8H8"/><path d="M12 5 9 8l3 3"/>',
    redo: '<path d="M15 8H9a4 4 0 0 0 0 8h7"/><path d="M12 5l3 3-3 3"/>',
    grid: '<path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
  };
  return `<svg class="cs-ic" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ''}</svg>`;
}

export function mountEditorChrome(
  scene: Phaser.Scene,
  handlers: ChromeHandlers,
): EditorChrome {
  const ui: UiScreen = mountForScene(scene, markup());
  let toastTimer = 0;

  for (const a of ACTIONS) {
    ui.onClick(`[data-act="${a.id}"]`, () => handlers.onAction(a.id));
  }
  for (const id of ['erase', 'mode', 'test', 'publish']) {
    ui.onClick(`[data-act="${id}"]`, () => handlers.onAction(id));
  }

  /* --- rename ---------------------------------------------------------- */

  // Both dialogs carry `.cs-dialog` for their styling, so each is found by the
  // class that says which one it is — a bare `.cs-dialog` would match whichever
  // happens to come first in the markup.
  const dialog = ui.find<HTMLDialogElement>('.cs-dialog-rename');
  const field = ui.find<HTMLInputElement>('.cs-field');

  const closeDialog = (): void => {
    dialog.close();
  };

  ui.onClick('[data-act="name"]', () => {
    field.value = ui.find('.cs-ed-name').textContent ?? '';
    dialog.showModal();
    field.select();
  });
  ui.onClick('[data-act="rename-cancel"]', closeDialog);
  ui.find('.cs-dialog-rename .cs-dialog-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = field.value.trim().slice(0, 24);
    closeDialog();
    if (name) handlers.onRename(name);
  });

  /* --- confirming a post ------------------------------------------------ */

  const postDialog = ui.find<HTMLDialogElement>('.cs-dialog-post');
  // Held between opening the dialog and the button that closes it, so the
  // caller can simply await an answer instead of being handed two callbacks.
  let settlePost: ((ok: boolean) => void) | null = null;

  const answerPost = (ok: boolean): void => {
    postDialog.close();
    settlePost?.(ok);
    settlePost = null;
  };

  ui.onClick('[data-act="post-cancel"]', () => answerPost(false));
  ui.onClick('[data-act="post-confirm"]', () => answerPost(true));
  // Escape and the backdrop close a `<dialog>` without going through either
  // button. Unanswered has to mean no, or the promise never settles and the
  // POST button stays disabled for the rest of the session.
  postDialog.addEventListener('close', () => {
    settlePost?.(false);
    settlePost = null;
  });

  /* --- the rail -------------------------------------------------------- */

  const rail = ui.find('.cs-rail');
  // One listener on the list rather than one per chip: the rail is rebuilt
  // whenever a count changes, and per-chip handlers would leak with it.
  rail.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-tool]');
    if (!chip || chip.hasAttribute('disabled')) return;
    handlers.onTool(chip.dataset.tool ?? '');
  });

  let lastTools = '';

  return {
    confirmPost(name: string): Promise<boolean> {
      ui.text('.cs-post-name', name.toUpperCase());
      postDialog.showModal();
      // Focus the way out, not the way through: the destructive-by-default
      // button should be the one you have to reach for.
      ui.find<HTMLButtonElement>('[data-act="post-cancel"]').focus();
      return new Promise<boolean>((resolve) => {
        settlePost = resolve;
      });
    },

    update(state: ChromeState): void {
      ui.text('.cs-ed-name', state.name.toUpperCase());

      const set = (act: string, on: boolean): void => {
        const el = ui.find<HTMLButtonElement>(`[data-act="${act}"]`);
        el.setAttribute('aria-pressed', String(on));
      };
      const enable = (act: string, on: boolean): void => {
        ui.find<HTMLButtonElement>(`[data-act="${act}"]`).disabled = !on;
      };

      enable('undo', state.canUndo);
      enable('redo', state.canRedo);
      set('grid', state.showGrid);
      set('erase', state.erase);
      set('mode', state.paintMode);
      ui.text('[data-act="mode"] .cs-tb-label', state.paintMode ? 'PAINT' : 'PAN');

      // The budget meter: cyan while there is room, gold when it is tight, red
      // at the ceiling — a builder should feel the wall before hitting it.
      const frac = state.total > 0 ? Math.min(1, state.used / state.total) : 0;
      const tone = frac >= 1 ? 'over' : frac > 0.8 ? 'tight' : 'ok';
      const meter = ui.find('.cs-meter-fill');
      meter.style.width = `${frac * 100}%`;
      ui.find('.cs-meter').dataset.tone = tone;
      ui.text('.cs-meter-value', `${state.used}/${state.total}`);

      // Publishing creates a Reddit post, so it is gated on the same proof as
      // saving — an arena its own author has never finished is not a level.
      const publish = ui.find<HTMLButtonElement>('[data-act="publish"]');
      publish.disabled = !state.verified || state.publishing === true;
      publish.textContent = state.publishing ? 'POSTING…' : 'POST';
      publish.title = state.verified
        ? 'Publish this level as a Reddit post anyone can play'
        : 'Clear the level in TEST before publishing it';

      // Rebuilt only when something actually changed: this runs on every paint
      // stroke, and rewriting the list each time would fight the scroll.
      const signature = JSON.stringify([state.tools, state.tool, state.erase]);
      if (signature !== lastTools) {
        lastTools = signature;
        rail.innerHTML = state.tools.map((t) => chip(t, t.id === state.tool)).join('');
      }
    },

    toast(message: string, ms = 1500): void {
      const el = ui.find('.cs-toast');
      el.textContent = message;
      el.dataset.on = 'true';
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        el.dataset.on = 'false';
      }, ms);
    },

    insets(): { top: number; left: number } {
      const d = dpr();
      const bar = ui.find('.cs-toolbar').getBoundingClientRect();
      const side = ui.find('.cs-rail-wrap').getBoundingClientRect();
      return { top: bar.height * d, left: side.width * d };
    },

    destroy(): void {
      window.clearTimeout(toastTimer);
      ui.destroy();
    },
  };
}

function chip(tool: ChromeTool, selected: boolean): string {
  return `
    <button type="button" class="cs-chip" data-tool="${esc(tool.id)}"
            aria-pressed="${selected}" ${tool.disabled ? 'disabled' : ''}>
      <span class="cs-chip-swatch" style="--swatch:${esc(tool.colour)}"></span>
      <span class="cs-chip-text">
        <span class="cs-chip-label">${esc(tool.label)}</span>
        <span class="cs-chip-sub">${esc(tool.sub)}</span>
      </span>
    </button>`;
}

function markup(): string {
  const buttons = ACTIONS.map(
    (a) => `
      <button type="button" class="cs-tb-btn" data-act="${a.id}" title="${a.title}"
              aria-label="${a.title}">${icon(a.icon)}</button>`,
  ).join('');

  return `
    <div class="cs-editor">
      <div class="cs-toolbar cs-glass">
        <div class="cs-tb-group">${buttons}</div>

        <button type="button" class="cs-tb-name" data-act="name" title="Rename this level">
          <span class="cs-ed-name">LEVEL</span>
        </button>

        <div class="cs-tb-group">
          <button type="button" class="cs-tb-btn cs-tb-wide" data-act="erase"
                  aria-pressed="false" title="Erase instead of place">
            <span class="cs-tb-label">ERASE</span>
          </button>
          <button type="button" class="cs-tb-btn cs-tb-wide" data-act="mode"
                  aria-pressed="false" title="What a drag does">
            <span class="cs-tb-label">PAN</span>
          </button>
        </div>

        <div class="cs-meter" data-tone="ok">
          <div class="cs-meter-track"><div class="cs-meter-fill"></div></div>
          <span class="cs-meter-value">0/0</span>
          <span class="cs-meter-label">pieces</span>
        </div>

        <div class="cs-tb-group cs-tb-verbs">
          <button type="button" class="cs-btn cs-tb-verb cs-tb-test" data-act="test">TEST</button>
          <button type="button" class="cs-btn cs-tb-verb cs-tb-publish" data-act="publish">POST</button>
        </div>
      </div>

      <div class="cs-rail-wrap cs-glass">
        <div class="cs-rail" role="group" aria-label="Pieces"></div>
      </div>

      <p class="cs-toast" data-on="false" role="status"></p>

      <dialog class="cs-dialog cs-dialog-post">
        <form class="cs-dialog-form" method="dialog">
          <p class="cs-label">Post this level as</p>
          <p class="cs-post-name"></p>
          <p class="cs-post-note">
            Everyone in the community can play it, and the name goes with it.
          </p>
          <div class="cs-dialog-actions">
            <button type="button" class="cs-btn cs-btn-ghost" data-act="post-cancel">
              RENAME IT
            </button>
            <button type="button" class="cs-btn cs-btn-primary" data-act="post-confirm">
              POST IT
            </button>
          </div>
        </form>
      </dialog>

      <dialog class="cs-dialog cs-dialog-rename">
        <form class="cs-dialog-form" method="dialog">
          <label class="cs-label" for="cs-name-field">Name this level</label>
          <input class="cs-field" id="cs-name-field" maxlength="24" autocomplete="off" />
          <div class="cs-dialog-actions">
            <button type="button" class="cs-btn cs-btn-ghost" data-act="rename-cancel">CANCEL</button>
            <button type="submit" class="cs-btn cs-btn-primary">RENAME</button>
          </div>
        </form>
      </dialog>
    </div>`;
}
