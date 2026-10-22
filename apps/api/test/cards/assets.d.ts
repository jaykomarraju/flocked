// The pixel fixtures come in as data URIs: Vite's `?inline` is the one import form that reaches a
// Workers test, which has no filesystem (test/cards/fixtures/build.mjs writes the files).
declare module '*.png?inline' {
  const uri: string;
  export default uri;
}
