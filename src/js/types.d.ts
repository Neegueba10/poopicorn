// No ambient game globals: game modules declare their own module-scoped
// `let r, Key, font, screenWidth, screenHeight` and assign them in init()
// (module bindings are mangleable by terser; implicit globals are not).
export {};
