// Jest resolver for TypeScript's NodeNext convention: our own source writes
// `.js` extensions on relative imports (e.g. `./app.module.js`) even though
// the real file is `app.module.ts`. A blanket moduleNameMapper stripping
// `.js` off every relative specifier looks right but also mangles node_modules
// packages' OWN internal relative imports, sending Jest hunting for sibling
// `.ts` source inside published packages that don't have any — hence trying
// the literal path first, and only stripping `.js` as a fallback when that
// fails, so real `.js` files (everything in node_modules) resolve normally.
module.exports = (request, options) => {
  if (/^\.{1,2}\//.test(request) && request.endsWith('.js')) {
    try {
      return options.defaultResolver(request, options);
    } catch {
      return options.defaultResolver(request.slice(0, -3), options);
    }
  }
  return options.defaultResolver(request, options);
};
