// Stands in for 'react-native' in test/rn.test.mjs: the library only reads Platform (OS, Version, constants.Release),
// and the test sets it on globalThis before the library loads.
exports.Platform = globalThis.__rnPlatform;
