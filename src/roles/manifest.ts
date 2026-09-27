import { z } from 'zod';
import { InvalidRoleManifestError } from './errors.ts';

const roleKeyPattern = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*$/;
const roleKeyRule = 'a role key is letters, digits and single dashes, starting with a letter and ending with a letter or digit';

/** A role key, the name a run refers to a role by, such as `finder-SCAN`. */
export const roleKeySchema = z.string().regex(roleKeyPattern, roleKeyRule);

/** A fragment file name: lower-case words joined by single dashes, with the `.md` extension and no directory part. */
export const fragmentNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*\.md$/, 'a fragment name is lower-case words joined by single dashes and ends in .md');

/**
 * Refuse an own `__proto__` key in the raw roles object. z.record skips that
 * key without reading it, so its assignment cannot replace the parsed
 * object's prototype, and the refinement below never sees it. JSON.parse
 * does make such a key, so without this step a manifest naming a role
 * `__proto__` would lose the role silently. The key breaks the role key
 * rule, so it is refused with that rule. Any issue here stops the roles
 * check before the record runs, so the other roles' problems are reported
 * once this key is gone.
 */
function refuseProtoRoleKey(roles: unknown, context: z.RefinementCtx): unknown {
  if (typeof roles === 'object' && roles !== null && Object.hasOwn(roles, '__proto__')) {
    context.addIssue({ code: 'custom', message: roleKeyRule, path: ['__proto__'] });
  }
  return roles;
}

/**
 * The manifest, `roles/manifest.json`: every role, each as the ordered list
 * of fragments its prompt is joined from. The manifest is the only place
 * composition is declared; a fragment never includes another (D1 of the
 * role prompts proposal). A fragment may appear in many roles but only once
 * in each, since a prompt that repeats a passage says nothing more.
 *
 * Role keys are unique ignoring case: a role's prompt is written to a file
 * named after its key, and on a case-insensitive file system, the default
 * on Windows and macOS, `finder-SCAN.md` and `finder-scan.md` are one file.
 *
 * Keys are checked in the refinement rather than by a key schema on the
 * record, so a bad key is reported with the rule it breaks and not as
 * "invalid key in record". The one key the record cannot see, `__proto__`,
 * is checked on the raw object first by `refuseProtoRoleKey`.
 */
export const roleManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roles: z.preprocess(refuseProtoRoleKey, z.record(z.string(), z.array(fragmentNameSchema).min(1)).superRefine((roles, context) => {
    if (Object.keys(roles).length === 0) context.addIssue({ code: 'custom', message: 'at least one role is required' });
    // Each key by its lower-case form, to find the first key another differs from only by case.
    const byFolded = new Map<string, string>();
    for (const [key, fragments] of Object.entries(roles)) {
      if (!roleKeyPattern.test(key)) context.addIssue({ code: 'custom', message: roleKeyRule, path: [key] });
      const folded = key.toLowerCase();
      const earlier = byFolded.get(folded);
      if (earlier === undefined) byFolded.set(folded, key);
      else context.addIssue({ code: 'custom', message: `role keys ${earlier} and ${key} differ only by case, so their prompt files would be one file on a case-insensitive file system`, path: [key] });
      const seen = new Set<string>();
      for (const fragment of fragments) {
        if (seen.has(fragment)) context.addIssue({ code: 'custom', message: `names ${fragment} twice`, path: [key] });
        seen.add(fragment);
      }
    }
  })),
});
export type RoleManifest = z.output<typeof roleManifestSchema>;

/** Validate a parsed manifest, naming every problem in one error. */
export function parseRoleManifest(value: unknown): RoleManifest {
  const parsed = roleManifestSchema.safeParse(value);
  if (!parsed.success) throw new InvalidRoleManifestError(`Invalid role manifest: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
