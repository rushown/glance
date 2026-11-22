// The web demo reuses the server's own modules (aliased by Vite). They are
// type-checked by the server's tsconfig, so the app treats them as untyped.
declare module '@server/*'
