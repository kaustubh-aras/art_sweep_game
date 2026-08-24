import Phaser from 'phaser';
import { C } from './theme';
import { GRAVITY } from './tuning';
import { BootScene } from '@/scenes/clockshot/BootScene';
import { MenuScene } from '@/scenes/clockshot/MenuScene';
import { HowToScene } from '@/scenes/clockshot/HowToScene';
import { PlayScene } from '@/scenes/clockshot/PlayScene';
import { ResultsScene } from '@/scenes/clockshot/ResultsScene';
import { LeaderboardScene } from '@/scenes/clockshot/LeaderboardScene';
import { PauseScene } from '@/scenes/clockshot/PauseScene';
import { ErrorScene } from '@/scenes/clockshot/ErrorScene';

/**
 * Phaser configuration for Clockshot.
 *
 * Scale mode is NONE because `src/ui/viewport.ts` owns the canvas size: it
 * keeps the backing store at the device pixel ratio (capped at 2) while the
 * CSS box matches its container exactly, so the page can never produce a
 * scrollbar inside the Reddit post.
 */
export const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: 400,
  height: 760, // replaced on the first frame by initViewport()
  backgroundColor: C.bg,
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
    // Both movement pads and the rope can be held at once.
    activePointers: 4,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: GRAVITY },
      // Off in production; flip to true to see bodies while tuning the arena.
      debug: false,
    },
  },
  scene: [
    BootScene,
    MenuScene,
    HowToScene,
    PlayScene,
    ResultsScene,
    LeaderboardScene,
    PauseScene,
    ErrorScene,
  ],
};
