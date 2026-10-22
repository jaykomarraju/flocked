// The two WebAssembly modules the renderer initialises. workerd refuses to compile WebAssembly from
// bytes at runtime, so both are imported as modules: wrangler's esbuild and Vite (the Workers tests)
// each hand the Worker a ready `WebAssembly.Module`.
declare module 'satori/yoga.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
declare module '@resvg/resvg-wasm/index_bg.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
