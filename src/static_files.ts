import { posix, resolve, win32 } from "node:path";

const WEB_DIRECTORY = resolve(import.meta.dirname ?? ".", "../web");

export function isPathWithin(
  root: string,
  candidate: string,
  os: "windows" | "posix" = Deno.build.os === "windows" ? "windows" : "posix",
): boolean {
  const paths = os === "windows" ? win32 : posix;
  const relativePath = paths.relative(root, candidate);
  return relativePath === "" ||
    (!paths.isAbsolute(relativePath) && relativePath !== ".." &&
      !relativePath.startsWith(`..${paths.sep}`));
}

export async function resolveWebAsset(
  pathname: string,
): Promise<string | null> {
  const requestedPath = pathname === "/"
    ? "index.html"
    : pathname.replace(/^\/+/, "");
  const webRoot = await Deno.realPath(WEB_DIRECTORY);
  const candidate = await Deno.realPath(resolve(webRoot, requestedPath)).catch(
    () => null,
  );
  return candidate && isPathWithin(webRoot, candidate) ? candidate : null;
}
