import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { lstat, mkdir, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
//#region src/roots.ts
/**
* Read roots and the containment fence that keeps the browser inside them.
*
* The harness's own `fs-sandbox` fences writes only — reads pass straight
* through to the local filesystem — so a browser-facing file API has to bring
* its own read fence or it publishes the whole disk over HTTP.
*
* @module dsh-plugin-workbench/roots
*/
/** Failure with an HTTP status attached, thrown by the fence and the handlers. */
var ApiError = class extends Error {
	/** HTTP status to answer with. */
	status;
	/** Stable machine-readable code. */
	code;
	/**
	* @param status - HTTP status.
	* @param code - stable error code.
	* @param message - human-readable detail.
	*/
	constructor(status, code, message) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
};
/**
* Whether `child` is `parent` itself or lives underneath it.
* @param parent - canonical parent path.
* @param child - canonical child path.
* @returns true when child does not escape parent.
*/
function isWithin(parent, child) {
	if (parent === child) return true;
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/**
* Check configured extra roots at load time.
*
* The harness's rule is that misconfiguration fails loud at load and that a
* missing referent is never silently skipped. A root that does not exist, or a
* relative path that cannot be resolved against anything meaningful, would
* otherwise sit in the picker and answer every request with a puzzling 404.
* @param extraRoots - the `readRoots` config value.
* @throws when any entry is relative, missing, or not a directory.
*/
function validateReadRoots(extraRoots) {
	const problems = [];
	for (const path of extraRoots) {
		if (!isAbsolute(path)) {
			problems.push(`${path} — must be an absolute path`);
			continue;
		}
		try {
			if (!statSync(path).isDirectory()) problems.push(`${path} — not a directory`);
		} catch {
			problems.push(`${path} — does not exist`);
		}
	}
	if (problems.length > 0) throw new Error(`workbench: readRoots is misconfigured:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
}
/**
* Compose the read roots for a request: the session workspace root first, then
* the configured extras.
* @param workspaceRoot - workspace root resolved from the sandbox policy.
* @param extraRoots - absolute directories from plugin config.
* @returns the roots, in display order.
*/
function composeRoots(workspaceRoot, extraRoots) {
	const roots = [{
		id: "workspace",
		path: workspaceRoot,
		label: workspaceRoot.split(sep).pop() ?? workspaceRoot
	}];
	extraRoots.forEach((path, index) => {
		if (!isAbsolute(path)) return;
		roots.push({
			id: `extra-${index}`,
			path,
			label: path.split(sep).pop() ?? path
		});
	});
	return roots;
}
/**
* Resolve an absolute directory the caller wants to start in, keeping it inside
* the fence.
*
* The browser hands the terminal a working directory — the session's cwd — and
* a working directory the client chose is exactly as untrusted as a `path`
* query, so it goes through the same two checks: it must be absolute, and its
* `realpath` must land within some allowed root. Returning the canonical path
* (not the caller's spelling) is deliberate: a symlinked cwd is followed here,
* before it reaches `node-pty.spawn`, so a shell can never open outside the
* fence.
* @param roots - the allowed roots.
* @param candidate - the absolute directory requested.
* @returns the canonical path when it is inside a root, otherwise null.
*/
async function resolveCwdWithinRoots(roots, candidate) {
	if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate)) return null;
	let canonical;
	try {
		canonical = await realpath(candidate);
	} catch {
		return null;
	}
	for (const root of roots) {
		let canonicalRoot;
		try {
			canonicalRoot = await realpath(root.path);
		} catch {
			continue;
		}
		if (isWithin(canonicalRoot, canonical)) return canonical;
	}
	return null;
}
/**
* Resolve a request's `root` + `path` pair to an absolute path inside that root.
*
* Two layers on purpose: a lexical reject of traversal input, then a
* `realpath` comparison so a symlink inside the root cannot point out of it.
* @param roots - the allowed roots.
* @param rootId - requested root id.
* @param relPath - requested path, relative to the root.
* @returns the absolute path, guaranteed to be inside the root.
* @throws ApiError when the root is unknown, the path is malformed, missing, or escapes.
*/
async function resolveInRoot(roots, rootId, relPath, options = {}) {
	const root = roots.find((candidate) => candidate.id === rootId);
	if (root === void 0) throw new ApiError(404, "unknown_root", `No such root: ${rootId}`);
	const cleaned = normalize(relPath.replaceAll("\\", "/")).replaceAll("\\", "/");
	if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith("../")) throw new ApiError(400, "invalid_path", "Path escapes its root");
	const absolutePath = cleaned === "." || cleaned === "" ? root.path : resolve(root.path, cleaned);
	let canonicalRoot;
	let canonicalTarget;
	try {
		canonicalRoot = await realpath(root.path);
	} catch {
		throw new ApiError(404, "not_found", "The root no longer exists");
	}
	try {
		canonicalTarget = await realpath(absolutePath);
	} catch {
		if (options.mustExist !== false) throw new ApiError(404, "not_found", "No such file or directory");
		try {
			canonicalTarget = `${await realpath(dirname(absolutePath))}/${basename(absolutePath)}`;
		} catch {
			throw new ApiError(404, "not_found", "Parent directory does not exist");
		}
	}
	if (!isWithin(canonicalRoot, canonicalTarget)) throw new ApiError(403, "outside_root", "Path resolves outside its root");
	return {
		root,
		absolutePath
	};
}
//#endregion
//#region src/write-guard.ts
/**
* The write side of the fence.
*
* Reading is confined to the plugin's configured roots. Writing has to clear a
* second bar, because those roots are chosen for browsing convenience while the
* harness has its own opinion about what may be modified:
*
*   - the sandbox mode must not be `read-only`;
*   - the target must sit under one of the sandbox policy's writable roots
*     (workspace root, `/tmp`, the OS temp dir) — the same set
*     `@deepseek-ai/dsh-sandbox`'s `writableRoots()` hands to the kernel-level
*     sandbox, restated here because that helper is not exported to plugins;
*   - a few names are never writable regardless of location.
*
* `ctx.fs.writeText` runs the harness's own per-call policy check on top of
* this for file contents; mkdir/rename/delete have no seam equivalent, so for
* those this module is the only gate.
*
* @module dsh-plugin-workbench/write-guard
*/
/** Names that stay read-only wherever they appear. */
const PROTECTED_NAMES = /* @__PURE__ */ new Set([
	".env",
	".env.local",
	"auth.json",
	"id_rsa",
	"id_ed25519",
	".npmrc"
]);
/** Path segments that are never writable through this API. */
const PROTECTED_SEGMENTS = /* @__PURE__ */ new Set([
	".git",
	".ssh",
	"node_modules"
]);
async function canonicalOrParent(absolutePath) {
	try {
		return await realpath(absolutePath);
	} catch {
		const parent = absolutePath.slice(0, Math.max(absolutePath.lastIndexOf("/"), 1));
		try {
			return `${await realpath(parent)}/${basename(absolutePath)}`;
		} catch {
			throw new ApiError(404, "not_found", "Parent directory does not exist");
		}
	}
}
/**
* Policy checks that need no filesystem access.
*
* Deliberately runs before the path is resolved: resolution touches disk and
* reports "no such parent" for a path this rule would refuse anyway, which
* turns a 403 into a misleading 404.
* @param ctx - plugin context (reads `ctx.sandboxPolicy`).
* @param relativePath - the request's path, relative to its root.
* @throws ApiError when the request must not proceed.
*/
function assertWritableRequest(ctx, relativePath) {
	if (ctx.sandboxPolicy.resolve().mode === "read-only") throw new ApiError(403, "sandbox_read_only", "The sandbox is in read-only mode");
	const segments = relativePath.split("/");
	const name = segments[segments.length - 1] ?? "";
	if (PROTECTED_NAMES.has(name)) throw new ApiError(403, "protected_file", `${name} cannot be modified through the workbench`);
	for (const segment of segments) if (PROTECTED_SEGMENTS.has(segment)) throw new ApiError(403, "protected_path", `${segment}/ cannot be modified through the workbench`);
}
/**
* Confirm the resolved target sits in a directory the sandbox policy allows
* writing to.
* @param ctx - plugin context (reads `ctx.sandboxPolicy`).
* @param absolutePath - the already root-confined absolute target.
* @throws ApiError when the target is outside every writable root.
*/
async function assertWritable(ctx, absolutePath) {
	const policy = ctx.sandboxPolicy.resolve();
	const name = basename(absolutePath);
	if (PROTECTED_NAMES.has(name)) throw new ApiError(403, "protected_file", `${name} cannot be modified through the workbench`);
	if (policy.mode === "danger-full-access") return;
	const target = await canonicalOrParent(absolutePath);
	if (!(await Promise.all([
		policy.workspaceRoot,
		"/tmp",
		tmpdir()
	].map(async (root) => {
		try {
			return await realpath(root);
		} catch {
			return root;
		}
	}))).some((root) => isWithin(root, target))) throw new ApiError(403, "outside_writable_root", "Path is outside every writable root of the current sandbox policy");
}
//#endregion
//#region src/search.ts
/**
* Filename search across a read root.
*
* A plain bounded walk rather than ripgrep: the harness's `tool-fs-search`
* owns a vendored rg binary, but it is an internal dependency resolved from
* the harness's own tree, and matching names does not need it. What this does
* need is limits — a workspace can contain a million files, and a browser
* asking for "a" must not stall the server or the event loop.
*
* @module dsh-plugin-workbench/search
*/
/** Directories never worth walking for a filename search. */
const SKIPPED = /* @__PURE__ */ new Set([
	".git",
	"node_modules",
	".venv",
	"__pycache__",
	".next",
	".turbo"
]);
/** Default limits: generous for a person, cheap for the server. */
const DEFAULT_LIMITS = {
	maxResults: 200,
	maxScanned: 2e4,
	budgetMs: 2e3
};
/**
* Walk `root` breadth-first, collecting entries whose name contains `query`.
*
* Breadth-first on purpose: shallow matches are the ones a person means, so a
* truncated search still returns the useful half. Symlinked directories are
* listed but never descended — that is both the cycle guard and the fence,
* since a link could otherwise walk straight out of the root.
* @param root - absolute directory to search.
* @param query - case-insensitive substring; the caller enforces a minimum length.
* @param limits - stopping conditions.
* @param now - clock, injectable for tests.
* @returns hits in breadth-first order.
*/
async function searchNames(root, query, limits = DEFAULT_LIMITS, now = Date.now) {
	const needle = query.normalize("NFC").toLowerCase();
	const deadline = now() + limits.budgetMs;
	const queue = [root];
	const hits = [];
	let scanned = 0;
	let truncated = false;
	while (queue.length > 0) {
		const dir = queue.shift();
		let handle;
		try {
			handle = await opendir(dir);
		} catch {
			continue;
		}
		for await (const entry of handle) {
			scanned += 1;
			if (scanned > limits.maxScanned || now() > deadline) {
				truncated = true;
				break;
			}
			const absolute = join(dir, entry.name);
			const isDirectory = entry.isDirectory();
			if (entry.name.normalize("NFC").toLowerCase().includes(needle)) {
				hits.push({
					path: relative(root, absolute).split("\\").join("/"),
					name: entry.name,
					isDirectory
				});
				if (hits.length >= limits.maxResults) {
					truncated = true;
					break;
				}
			}
			if (isDirectory && !entry.isSymbolicLink() && !SKIPPED.has(entry.name)) queue.push(absolute);
		}
		if (truncated) break;
	}
	return {
		hits,
		truncated,
		scanned
	};
}
//#endregion
//#region src/origin.ts
/**
* Whether a request may act on the app's behalf: either it is not from a
* browser (no `Origin`), or its `Origin` is this same server.
*
* @param req - the incoming HTTP request or upgrade.
* @returns `true` when the request is allowed to proceed.
*/
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	const host = req.headers.host;
	if (host === void 0) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
//#endregion
//#region src/api.ts
/** Largest text file the editor/preview will fetch. */
const MAX_TEXT_BYTES = 2097152;
/** Largest binary payload the preview will stream (images, mostly). */
const MAX_BYTES = 33554432;
/** Loopback addresses accepted when `loopbackOnly` is on. */
const LOOPBACK$1 = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
const MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf"
};
/** Read the request body, refusing anything over the write cap. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		total += buffer.byteLength;
		if (total > 33554432) throw new ApiError(413, "body_too_large", "Request body is too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(payload);
}
function sendError(res, error) {
	if (error instanceof ApiError) {
		sendJson(res, error.status, {
			error: error.message,
			code: error.code
		});
		return;
	}
	sendJson(res, 500, {
		error: error instanceof Error ? error.message : String(error),
		code: "internal"
	});
}
/** Whether something is already at this path (a broken symlink counts). */
async function exists(absolutePath) {
	try {
		await lstat(absolutePath);
		return true;
	} catch {
		return false;
	}
}
function requireQuery(url, key) {
	const value = url.searchParams.get(key);
	if (value === null) throw new ApiError(400, "missing_param", `Missing query parameter: ${key}`);
	return value;
}
/**
* Resolve a mutating request's target, which may not exist yet.
*
* A root itself is never a target. An empty `path` resolves to the root, so
* without this guard `DELETE ?path=&recursive=1` answers `{ok:true}` after
* deleting the entire workspace — the worst possible reading of a request the
* UI would never send but the API must still refuse.
*
* `refuseSymlink` closes a subtler hole. The root fence realpaths the target,
* but a target that does not exist yet has no realpath, so it anchors on the
* parent instead — and a *dangling* symlink as the final component has an
* existing parent, so it slips through, after which a following write (raw
* `writeFile` in `upload`) lands wherever the link points: outside the root,
* outside every writable sandbox root (confirmed — an upload planted a file in
* `$HOME`). A middle-of-path symlink is already caught, because realpath of the
* parent follows it; only the last component is appended literally. Writing
* *through* a symlink is never what the file browser means, so write/upload/
* mkdir refuse one outright; rename and delete operate on the link itself and
* leave it off.
* @param roots - the allowed roots.
* @param url - the request URL carrying `root` and `path`.
* @param pathKey - which query parameter holds the path.
* @param opts - `refuseSymlink` rejects a final component that is a symlink.
* @returns the resolved target.
* @throws ApiError when the target is a root or a refused symlink.
*/
async function resolveInRootForWrite(roots, url, pathKey = "path", opts = {}) {
	const resolved = await resolveInRoot(roots, requireQuery(url, "root"), requireQuery(url, pathKey), { mustExist: false });
	if (resolved.absolutePath === resolved.root.path) throw new ApiError(400, "root_is_not_a_target", "A root itself cannot be created, renamed, or deleted");
	if (opts.refuseSymlink === true) {
		let link = false;
		try {
			link = (await lstat(resolved.absolutePath)).isSymbolicLink();
		} catch {}
		if (link) throw new ApiError(403, "symlink_target", "Refusing to write through a symlink");
	}
	return resolved;
}
/** Sort directories first, then by name, so the tree reads like a file manager. */
function compareEntries(a, b) {
	const aDir = a.type === "directory";
	if (aDir !== (b.type === "directory")) return aDir ? -1 : 1;
	return a.name.localeCompare(b.name);
}
/**
* Ceiling on names held while deciding what a listing shows. Well past any
* directory a person browses; it exists so a pathological one cannot grow the
* heap without bound.
*/
const MAX_SCAN_ENTRIES = 5e4;
/**
* List a directory, capped at `maxEntries`.
*
* Two passes on purpose. Truncating the dirent stream directly would hand back
* whichever names the filesystem happened to yield first — an arbitrary subset,
* sorted afterwards so it *looks* ordered. In a directory past the cap that
* quietly drops subdirectories, and a subdirectory you cannot see is one you
* cannot open. So: collect names and kinds first (cheap, no syscall per entry),
* sort, cut, and only then stat the survivors — the expensive pass stays capped
* at `maxEntries` either way.
*/
async function listDirectory(absolutePath, maxEntries) {
	let dir;
	try {
		dir = await opendir(absolutePath);
	} catch {
		throw new ApiError(404, "not_a_directory", "Not a directory");
	}
	const names = [];
	let truncated = false;
	for await (const child of dir) {
		if (names.length >= MAX_SCAN_ENTRIES) {
			truncated = true;
			break;
		}
		names.push({
			name: child.name,
			type: child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other"
		});
	}
	names.sort(compareEntries);
	if (names.length > maxEntries) {
		names.length = maxEntries;
		truncated = true;
	}
	const entries = [];
	for (const child of names) {
		const childPath = join(absolutePath, child.name);
		let size = 0;
		let mtime = "";
		try {
			const info = await lstat(childPath);
			size = info.size;
			mtime = info.mtime.toISOString();
		} catch {}
		let linkTarget;
		if (child.type === "symlink") try {
			const target = await stat(childPath);
			linkTarget = target.isDirectory() ? "directory" : target.isFile() ? "file" : "other";
		} catch {
			linkTarget = "broken";
		}
		entries.push({
			name: child.name,
			type: child.type,
			size,
			mtime,
			...linkTarget === void 0 ? {} : { linkTarget }
		});
	}
	return {
		entries,
		truncated
	};
}
/**
* Build the request handler for the workbench file API.
* @param ctx - plugin context (reads `ctx.fs` and `ctx.sandboxPolicy`).
* @param options - live plugin settings.
* @returns a handler for the `/plugins/workbench/api/` prefix route.
*/
function createApiHandler(ctx, options) {
	const roots = () => composeRoots(ctx.sandboxPolicy.resolve().workspaceRoot, options.readRoots);
	return async function handle(req, res) {
		try {
			if (options.loopbackOnly && !LOOPBACK$1.has(req.socket.remoteAddress ?? "")) throw new ApiError(403, "not_loopback", "The workbench API is restricted to loopback callers");
			const url = new URL(req.url ?? "/", "http://workbench.local");
			const route = url.pathname.replace(/^\/plugins\/workbench\/api\/?/, "");
			const method = req.method ?? "GET";
			const mutating = method !== "GET" && method !== "HEAD";
			if (mutating && !options.writeEnabled) throw new ApiError(403, "write_disabled", "Set workbench config writeEnabled: true to allow changes");
			if (mutating && !isSameOrigin(req)) throw new ApiError(403, "cross_origin", "Cross-origin requests may not change files");
			if (route === "health") {
				sendJson(res, 200, {
					ok: true,
					writeEnabled: options.writeEnabled,
					ptyEnabled: options.ptyEnabled
				});
				return;
			}
			if (route === "roots") {
				sendJson(res, 200, { roots: roots().map(({ id, path, label }) => ({
					id,
					path,
					label
				})) });
				return;
			}
			if (route === "list") {
				const { root, absolutePath } = await resolveInRoot(roots(), requireQuery(url, "root"), url.searchParams.get("path") ?? "");
				const { entries, truncated } = await listDirectory(absolutePath, options.maxListEntries);
				sendJson(res, 200, {
					root: root.id,
					path: url.searchParams.get("path") ?? "",
					absolutePath,
					entries,
					truncated
				});
				return;
			}
			if (route === "stat") {
				const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, "root"), requireQuery(url, "path"));
				const info = await stat(absolutePath);
				const target = await ctx.fs.resolve(absolutePath);
				const seam = await ctx.fs.stat(target);
				sendJson(res, 200, {
					type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
					size: info.size,
					version: seam?.version ?? null
				});
				return;
			}
			if (route === "search") {
				const query = requireQuery(url, "q");
				if (query.trim().length < 2) throw new ApiError(400, "query_too_short", "Search needs at least two characters");
				const { root, absolutePath } = await resolveInRoot(roots(), requireQuery(url, "root"), url.searchParams.get("path") ?? "");
				const result = await searchNames(absolutePath, query.trim(), DEFAULT_LIMITS);
				sendJson(res, 200, {
					root: root.id,
					query: query.trim(),
					...result
				});
				return;
			}
			if (route === "read") {
				const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, "root"), requireQuery(url, "path"));
				const info = await stat(absolutePath);
				if (info.isDirectory()) throw new ApiError(400, "not_a_file", "Path is a directory");
				if (!info.isFile()) throw new ApiError(400, "not_a_file", "Path is not a regular file");
				if (info.size > MAX_TEXT_BYTES) throw new ApiError(413, "file_too_large", "File is too large to display");
				const target = await ctx.fs.resolve(absolutePath);
				const bytes = await ctx.fs.readBytes(target, void 0, MAX_TEXT_BYTES);
				if (bytes.includes(0)) throw new ApiError(415, "binary_file", "File is not text");
				const buffer = Buffer.from(bytes);
				const text = buffer.toString("utf-8");
				if (!Buffer.from(text, "utf-8").equals(buffer)) throw new ApiError(415, "not_utf8", "File is text but not UTF-8; the workbench cannot display it");
				const stat_ = await ctx.fs.stat(target);
				sendJson(res, 200, {
					path: url.searchParams.get("path"),
					size: info.size,
					content: text,
					version: stat_?.version ?? null
				});
				return;
			}
			if (route === "bytes") {
				const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, "root"), requireQuery(url, "path"));
				const info = await stat(absolutePath);
				if (info.isDirectory()) throw new ApiError(400, "not_a_file", "Path is a directory");
				if (!info.isFile()) throw new ApiError(400, "not_a_file", "Path is not a regular file");
				if (info.size > MAX_BYTES) throw new ApiError(413, "file_too_large", "File is too large to stream");
				const target = await ctx.fs.resolve(absolutePath);
				const bytes = await ctx.fs.readBytes(target, void 0, MAX_BYTES);
				const body = Buffer.from(bytes);
				res.writeHead(200, {
					"content-type": MIME[extname(absolutePath).toLowerCase()] ?? "application/octet-stream",
					"content-length": String(body.byteLength),
					"content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(absolutePath))}`,
					"cache-control": "no-store",
					"content-security-policy": "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; sandbox",
					"x-content-type-options": "nosniff"
				});
				res.end(req.method === "HEAD" ? void 0 : body);
				return;
			}
			if (route === "write" || route === "upload") {
				if (method !== "PUT" && method !== "POST") throw new ApiError(405, "method_not_allowed", "Use PUT or POST");
				assertWritableRequest(ctx, requireQuery(url, "path"));
				const { absolutePath } = await resolveInRootForWrite(roots(), url, "path", { refuseSymlink: true });
				await assertWritable(ctx, absolutePath);
				const body = await readBody(req);
				const overwrote = await exists(absolutePath);
				let version = null;
				if (route === "write") {
					const target = await ctx.fs.resolve(absolutePath);
					const expected = url.searchParams.get("version");
					try {
						await ctx.fs.writeText(target, body.toString("utf-8"), expected === null ? void 0 : {
							kind: "replaceIfVersion",
							version: expected
						});
					} catch (error) {
						if (error.code === "FS_STALE_VERSION") throw new ApiError(409, "stale_version", "The file changed on disk since it was opened");
						throw error;
					}
					version = (await ctx.fs.stat(await ctx.fs.resolve(absolutePath)))?.version ?? null;
				} else await writeFile(absolutePath, body);
				sendJson(res, 200, {
					ok: true,
					bytes: body.byteLength,
					overwrote,
					version
				});
				return;
			}
			if (route === "mkdir") {
				if (method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST");
				assertWritableRequest(ctx, requireQuery(url, "path"));
				const { absolutePath } = await resolveInRootForWrite(roots(), url, "path", { refuseSymlink: true });
				await assertWritable(ctx, absolutePath);
				await mkdir(absolutePath, { recursive: true });
				sendJson(res, 200, { ok: true });
				return;
			}
			if (route === "rename") {
				if (method !== "POST") throw new ApiError(405, "method_not_allowed", "Use POST");
				assertWritableRequest(ctx, requireQuery(url, "path"));
				const { absolutePath } = await resolveInRootForWrite(roots(), url);
				await assertWritable(ctx, absolutePath);
				assertWritableRequest(ctx, requireQuery(url, "to"));
				const destination = await resolveInRootForWrite(roots(), url, "to");
				await assertWritable(ctx, destination.absolutePath);
				if (url.searchParams.get("overwrite") !== "1" && await exists(destination.absolutePath)) throw new ApiError(409, "destination_exists", "Something is already there; pass overwrite=1 to replace it");
				await rename(absolutePath, destination.absolutePath);
				sendJson(res, 200, { ok: true });
				return;
			}
			if (route === "delete") {
				if (method !== "DELETE" && method !== "POST") throw new ApiError(405, "method_not_allowed", "Use DELETE");
				assertWritableRequest(ctx, requireQuery(url, "path"));
				const { absolutePath } = await resolveInRootForWrite(roots(), url);
				await assertWritable(ctx, absolutePath);
				const info = await lstat(absolutePath).catch(() => null);
				if (info === null) throw new ApiError(404, "not_found", "No such file or directory");
				if (info.isDirectory() && url.searchParams.get("recursive") !== "1") throw new ApiError(400, "is_directory", "Pass recursive=1 to delete a directory");
				await rm(absolutePath, {
					recursive: info.isDirectory(),
					force: false
				});
				sendJson(res, 200, { ok: true });
				return;
			}
			throw new ApiError(404, "unknown_route", `No such workbench route: ${route}`);
		} catch (error) {
			sendError(res, error);
		}
	};
}
//#endregion
//#region src/pty.ts
/** Chunks buffered for a background session before its tab is looked at again. */
const MAX_BUFFERED_CHUNKS = 5e3;
/** terminfo entry advertised to the shell; matches what xterm.js implements. */
const TERM_NAME = "xterm-256color";
const LOOPBACK = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/**
* Restore the execute bit on node-pty's `spawn-helper`.
*
* Package managers that extract from a content-addressed store (pnpm, and any
* tarball copy that loses modes) can leave the helper at 0644. node-pty then
* fails every spawn with a bare `posix_spawnp failed.`, which says nothing
* about the cause. Cheap to check, and it turns an opaque failure into none.
* @param requireFrom - a require bound to the tree node-pty was resolved from.
*/
function ensureSpawnHelperExecutable(requireFrom) {
	if (process.platform === "win32") return;
	try {
		const root = dirname(requireFrom.resolve("node-pty/package.json"));
		const candidates = [
			join(root, "build", "Release", "spawn-helper"),
			join(root, "build", "Debug", "spawn-helper"),
			join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
		];
		for (const helper of candidates) {
			if (!existsSync(helper)) continue;
			try {
				accessSync(helper, constants.X_OK);
			} catch {
				chmodSync(helper, 493);
			}
		}
	} catch {}
}
/**
* Load node-pty from whichever tree actually has it.
*
* A plugin installed with `link:` keeps its own node_modules, so resolving
* from this module alone misses the copy dsh already installed in the profile.
* `ctx.baseUrl` is the profile directory (where cordis.yml lives), and pnpm's
* hoisted profile layout puts node-pty directly under it.
* @param baseUrl - the loader's base URL for this entry, when it has one.
* @returns the node-pty module.
* @throws when no anchor resolves it, naming every path tried.
*/
function loadNodePty(baseUrl) {
	const anchors = [import.meta.url, ...baseUrl === void 0 ? [] : [baseUrl]];
	const failures = [];
	for (const anchor of anchors) try {
		const requireFrom = createRequire(anchor);
		requireFrom.resolve("node-pty");
		ensureSpawnHelperExecutable(requireFrom);
		return requireFrom("node-pty");
	} catch (error) {
		failures.push(`${anchor}: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
	}
	throw new Error("workbench: ptyEnabled is on but node-pty could not be resolved. Install it into the profile (dsh plugin --profile <name> add node-pty) or into this plugin. Tried:\n" + failures.map((line) => `  - ${line}`).join("\n"));
}
/** Pick a login shell for the platform. */
function detectShell(configured) {
	if (configured !== "") return configured;
	if (process.platform === "win32") return "powershell.exe";
	for (const candidate of [
		process.env.SHELL,
		"/bin/zsh",
		"/bin/bash"
	]) if (candidate !== void 0 && candidate !== "" && existsSync(candidate)) return candidate;
	return "/bin/bash";
}
function shellName(shell) {
	return shell.split("/").pop() ?? "shell";
}
function newId() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/**
* Wrap the shell argv in the kernel-level sandbox unless the policy is
* full access — the same rule `terminal-bash` applies to agent PTYs.
* @param ctx - plugin context.
* @param shell - shell executable.
* @returns argv to spawn (confined when the mode requires it) and the policy's
* workspace root, which is both the fence anchor and the fallback cwd.
*/
function confinedArgv(ctx, shell) {
	const policy = ctx.sandboxPolicy.resolve();
	const argv = [shell];
	if (policy.mode === "danger-full-access") return {
		argv,
		mode: policy.mode,
		workspaceRoot: policy.workspaceRoot
	};
	const sandbox = ctx.get("sandbox");
	if (sandbox === void 0) throw new Error(`workbench: sandbox mode "${policy.mode}" needs a ctx.sandbox provider to open a terminal`);
	return {
		argv: [...sandbox.confine(argv, {
			...policy,
			mode: policy.mode
		}).argv],
		mode: policy.mode,
		workspaceRoot: policy.workspaceRoot
	};
}
/**
* Build the upgrade handler that serves browser terminals.
* @param ctx - plugin context (reads `ctx.sandboxPolicy` and optionally `ctx.sandbox`).
* @param options - live plugin settings.
* @returns the upgrade handler plus a disposer that kills every live shell.
*/
function createPtyGateway(ctx, options) {
	const pty = loadNodePty(ctx.baseUrl);
	const server = new WebSocketServer({ noServer: true });
	const connections = /* @__PURE__ */ new Set();
	/**
	* Where a new shell should open.
	*
	* The browser asks for the session's cwd; anything the client chose is as
	* untrusted as a file path, so it is fenced exactly the same way — canonical,
	* inside an allowed root, or rejected. A rejected or absent request falls back
	* to the workspace root, never to whatever was asked for.
	* @param requested - the client's desired cwd, or undefined.
	* @param workspaceRoot - the policy workspace root, both fence anchor and fallback.
	* @returns a directory guaranteed to be inside the fence.
	*/
	async function resolveSpawnCwd(requested, workspaceRoot) {
		if (requested === void 0 || requested === "") return workspaceRoot;
		return await resolveCwdWithinRoots(composeRoots(workspaceRoot, options.readRoots), requested) ?? workspaceRoot;
	}
	async function spawnSession(requestedCwd) {
		const shell = detectShell(options.shell);
		const { argv, workspaceRoot } = confinedArgv(ctx, shell);
		const [file, ...args] = argv;
		if (file === void 0) throw new Error("workbench: empty shell argv");
		const cwd = await resolveSpawnCwd(requestedCwd, workspaceRoot);
		const child = pty.spawn(file, args, {
			name: TERM_NAME,
			cols: 80,
			rows: 24,
			cwd,
			env: {
				...process.env,
				TERM: TERM_NAME,
				DSH_WORKBENCH: "1"
			}
		});
		return {
			id: newId(),
			pty: child,
			shell: shellName(shell),
			createdAt: Date.now()
		};
	}
	function attach(conn, session, socket) {
		session.pty.onData((data) => {
			if (socket.readyState !== socket.OPEN) return;
			if (conn.activeSessionId === session.id) {
				socket.send(data);
				return;
			}
			const buffered = conn.buffers.get(session.id) ?? [];
			buffered.push(data);
			if (buffered.length > MAX_BUFFERED_CHUNKS) buffered.splice(0, buffered.length - MAX_BUFFERED_CHUNKS);
			conn.buffers.set(session.id, buffered);
		});
		session.pty.onExit(({ exitCode }) => {
			conn.sessions.delete(session.id);
			conn.buffers.delete(session.id);
			if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({
				type: "exited",
				id: session.id,
				exitCode
			}));
		});
	}
	/**
	* Kill a connection's shells and forget it.
	* @param conn - the connection being torn down.
	* @param hangUp - also close the browser socket. `ws.close()` on the server
	* does NOT close established connections, so on plugin teardown the browser
	* would otherwise keep a socket to a gateway that no longer exists — no close
	* event, so no reconnect, and a terminal frozen for good.
	*/
	function killAll(conn, hangUp = false) {
		for (const session of conn.sessions.values()) try {
			session.pty.kill();
		} catch {}
		conn.sessions.clear();
		conn.buffers.clear();
		connections.delete(conn);
		if (hangUp && conn.socket.readyState === conn.socket.OPEN) try {
			conn.socket.close(1001, "workbench gateway unloaded");
		} catch {}
	}
	server.on("connection", (socket, req) => {
		const conn = {
			sessions: /* @__PURE__ */ new Map(),
			activeSessionId: null,
			buffers: /* @__PURE__ */ new Map(),
			socket
		};
		connections.add(conn);
		let connectionCwd;
		try {
			connectionCwd = new URL(req.url ?? "/", "http://workbench.local").searchParams.get("cwd") ?? void 0;
		} catch {
			connectionCwd = void 0;
		}
		async function create(requestedCwd) {
			let session;
			try {
				session = await spawnSession(requestedCwd ?? connectionCwd);
			} catch (error) {
				socket.send(JSON.stringify({
					type: "error",
					message: error instanceof Error ? error.message : String(error)
				}));
				return;
			}
			conn.sessions.set(session.id, session);
			conn.activeSessionId = session.id;
			attach(conn, session, socket);
			socket.send(JSON.stringify({
				type: "created",
				id: session.id,
				pid: session.pty.pid,
				shell: session.shell
			}));
		}
		function control(message) {
			switch (message.type) {
				case "create":
					create(typeof message.cwd === "string" ? message.cwd : void 0);
					return;
				case "switch": {
					const session = message.sessionId === void 0 ? void 0 : conn.sessions.get(message.sessionId);
					if (session === void 0) {
						socket.send(JSON.stringify({
							type: "error",
							message: "No such terminal session"
						}));
						return;
					}
					conn.activeSessionId = session.id;
					socket.send(JSON.stringify({
						type: "switched",
						id: session.id
					}));
					const buffered = conn.buffers.get(session.id);
					if (buffered !== void 0) {
						for (const chunk of buffered) socket.send(chunk);
						conn.buffers.delete(session.id);
					}
					return;
				}
				case "close": {
					const session = message.sessionId === void 0 ? void 0 : conn.sessions.get(message.sessionId);
					if (session === void 0) return;
					try {
						session.pty.kill();
					} catch {}
					conn.sessions.delete(session.id);
					conn.buffers.delete(session.id);
					if (conn.activeSessionId === session.id) conn.activeSessionId = conn.sessions.keys().next().value ?? null;
					return;
				}
				case "resize": {
					const session = conn.activeSessionId === null ? void 0 : conn.sessions.get(conn.activeSessionId);
					if (session === void 0) return;
					try {
						session.pty.resize(Math.max(1, message.cols ?? 80), Math.max(1, message.rows ?? 24));
					} catch {}
					return;
				}
				default: socket.send(JSON.stringify({
					type: "error",
					message: `Unknown control message: ${String(message.type)}`
				}));
			}
		}
		socket.on("message", (raw) => {
			const text = typeof raw === "string" ? raw : raw.toString("utf8");
			if (text.charCodeAt(0) === 123) try {
				control(JSON.parse(text));
				return;
			} catch {}
			(conn.activeSessionId === null ? void 0 : conn.sessions.get(conn.activeSessionId))?.pty.write(text);
		});
		socket.on("close", () => {
			killAll(conn);
		});
		socket.on("error", () => {
			killAll(conn);
		});
		create();
	});
	return {
		handler: (req, socket, head) => {
			if (options.loopbackOnly && !LOOPBACK.has(req.socket.remoteAddress ?? "")) {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
			if (!isSameOrigin(req)) {
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}
			server.handleUpgrade(req, socket, head, (client) => {
				server.emit("connection", client, req);
			});
		},
		dispose: () => {
			for (const conn of [...connections]) killAll(conn, true);
			server.close();
		}
	};
}
//#endregion
//#region src/index.ts
/** Cordis plugin name. */
const name = "workbench";
/** Services the host half needs to be present. */
const inject = [
	"webServer",
	"fs",
	"sandboxPolicy"
];
/** Runtime schema for {@link Config}. */
const Config = z.object({
	readRoots: z.array(z.string()).default([]),
	writeEnabled: z.boolean().default(false),
	ptyEnabled: z.boolean().default(false),
	loopbackOnly: z.boolean().default(true),
	maxListEntries: z.number().default(1e3),
	shell: z.string().default("")
});
/** Mount the workbench host surface. */
function apply(ctx, config) {
	validateReadRoots(config.readRoots);
	const handler = createApiHandler(ctx, {
		readRoots: config.readRoots,
		loopbackOnly: config.loopbackOnly,
		maxListEntries: config.maxListEntries,
		writeEnabled: config.writeEnabled,
		ptyEnabled: config.ptyEnabled
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/plugins/workbench/api",
		handler
	}), "workbench: file API");
	if (!config.ptyEnabled) return;
	ctx.effect(() => {
		const gateway = createPtyGateway(ctx, {
			loopbackOnly: config.loopbackOnly,
			shell: config.shell,
			readRoots: config.readRoots
		});
		const removeRoute = ctx.webServer.registerUpgrade({
			path: "/plugins/workbench/pty",
			handler: gateway.handler
		});
		return () => {
			removeRoute();
			gateway.dispose();
		};
	}, "workbench: pty gateway");
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map