/**
 * Tiny glob matcher — supports `**`, `*`, `?`. No dependencies.
 *
 * Semantics:
 *   `**` matches any number of path segments (including zero when followed by `/`)
 *   `*`  matches within a single segment (never `/`)
 *   `?`  matches exactly one character within a segment (never `/`)
 *
 * Paths are normalized: backslashes → `/`, leading `./` stripped.
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Normalize a file path for matching: forward slashes, no leading "./" or "/". */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Compile a glob pattern to a RegExp anchored at both ends. */
export function globToRegExp(pattern: string): RegExp {
  const glob = normalizePath(pattern.trim());
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` — collapse any following slash into the group so it matches zero segments too.
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += ch.replace(REGEX_SPECIALS, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `path` matches the glob `pattern`. */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path));
}

/** True if `path` matches any of `patterns`. */
export function matchAny(patterns: string[], path: string): boolean {
  const p = normalizePath(path);
  return patterns.some((pat) => globToRegExp(pat).test(p));
}
