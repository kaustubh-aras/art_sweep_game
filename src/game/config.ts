import Phaser from 'phaser';
import { T } from '@/ui/theme';
import { BootScene } from '@/scenes/BootScene';
import { MenuScene } from '@/scenes/MenuScene';
import { TutorialScene } from '@/scenes/TutorialScene';
import { GuessScene } from '@/scenes/GuessScene';
import { DrawScene } from '@/scenes/DrawScene';
import { PostScene } from '@/scenes/PostScene';
import { PauseScene } from '@/scenes/PauseScene';
import { ResultsScene } from '@/scenes/ResultsScene';

/**
 * Phaser game config.
 *
 * Scale mode is `NONE`: `src/ui/viewport.ts` owns the canvas size so the
 * backing store can run at the device pixel ratio (capped at 2, GDD §11) while
 * the canvas' CSS box stays exactly the size of its container. Nothing can
 * overflow, so the page has no way to produce a scrollbar.
 *
 * No physics system is enabled — the sweep is angle maths, not bodies.
 */
export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: 800,
  height: 600, // replaced on the first frame by initViewport()
  backgroundColor: T.bg,
  disableContextMenu: true,
  scale: {
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  render: {
    antialias: true,
    powerPreference: 'high-performance',
  },
  input: {
    // Drawing with one thumb while the other holds an ink swatch, etc.
    activePointers: 4,
  },
  scene: [
    BootScene,
    MenuScene,
    TutorialScene,
    GuessScene,
    DrawScene,
    PostScene,
    ResultsScene,
    PauseScene,
  ],
};
