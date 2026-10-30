export const SYSTEM_TOOLS = Object.freeze({
  cp: process.platform === "win32" ? "cp" : "/bin/cp",
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  xattr: "/usr/bin/xattr",
  sevenZip: "C:\\Program Files\\7-Zip\\7z.exe",
});

