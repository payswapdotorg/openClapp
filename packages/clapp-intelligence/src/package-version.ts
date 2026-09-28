/**
 * Package version rules (CLAPP-W2-005).
 *
 * v0.1 versions are MAJOR.MINOR.PATCH with numeric (decimal, non-negative)
 * components and no pre-release/build suffix. Leading zeros are tolerated
 * and normalized away ("1.02.0" and "1.2.0" denote the same version), which
 * keeps identity, store keys and ordering coherent. Anything that is not
 * three dot-separated digit groups is non-conforming and must be rejected
 * by document validation.
 *
 * Comparison is exact (BigInt components), total and deterministic: when an
 * input is non-conforming the comparison falls back to the deterministic
 * code-unit string order so the function is defined for every input pair
 * (the registry only ever feeds it conforming versions).
 */

/** Parsed MAJOR.MINOR.PATCH version with exact numeric components. */
export interface ParsedPackageVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
}

/** Three dot-separated digit groups, optionally zero-padded. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** True when the string is a conforming MAJOR.MINOR.PATCH version. */
export function isConformingVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

/**
 * Parses a conforming version into exact numeric components.
 * Returns null for non-conforming strings; never throws.
 */
export function parsePackageVersion(version: string): ParsedPackageVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    return null;
  }
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]) };
}

/**
 * Canonical spelling of a version: conforming input with leading zeros
 * stripped ("1.02.0" -> "1.2.0"). Non-conforming input is returned verbatim
 * (validation rejects it before the registry ever keys on it).
 */
export function normalizePackageVersion(version: string): string {
  const parsed = parsePackageVersion(version);
  if (parsed === null) {
    return version;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Total, deterministic comparison of two version strings.
 *
 * Conforming versions compare MAJOR, then MINOR, then PATCH numerically and
 * exactly (BigInt, so arbitrarily large components stay distinct). If either
 * input is non-conforming, the pair compares by deterministic code-unit
 * string order, with conforming versions sorting before non-conforming ones
 * so the relation stays a strict weak ordering. Returns -1, 0 or 1.
 */
export function comparePackageVersions(a: string, b: string): number {
  const left = parsePackageVersion(a);
  const right = parsePackageVersion(b);
  if (left !== null && right !== null) {
    const fields = [left.major, left.minor, left.patch] as const;
    const other = [right.major, right.minor, right.patch] as const;
    for (let index = 0; index < fields.length; index += 1) {
      if (fields[index] < other[index]) {
        return -1;
      }
      if (fields[index] > other[index]) {
        return 1;
      }
    }
    return 0;
  }
  // Keep the fallback a strict weak ordering: conforming < non-conforming.
  if (left !== null) {
    return -1;
  }
  if (right !== null) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
