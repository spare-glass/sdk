// @spare-glass/sdk 的公开接口
export { SpacError, lex, parse, Compiler, Strings, BUILTINS, ARITY, EVENTS, LIMITS, OP } from './compiler.ts';
export { checkManifest, checkControls, flattenUi } from './manifest.ts';
export { build, pngGray, crc32, fnv, ed25519, type AppFiles } from './pack.ts';
export { encodeQr, qrToTerminal, qrToSvg, type QrCode, type Ecc } from './qr.ts';
export { serveSideload, sideloadLink, lanAddress, type Sideload, type SideloadOptions } from './sideload.ts';
