/// <reference types="vite/client" />

/** Vite emits these as fingerprinted URLs; it has no built-in types for them. */
declare module '*.webm' {
  const src: string;
  export default src;
}

declare module '*.mp4' {
  const src: string;
  export default src;
}
