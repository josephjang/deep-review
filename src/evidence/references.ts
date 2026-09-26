import { artifactReferenceSchema, type ArtifactReference } from './store.ts';

/**
 * Every artifact reference inside a payload, wherever it sits. A reference is
 * any object that is exactly `{ sha256, bytes }` in the reference's shape, so
 * a new event kind that carries evidence is checked without declaring it.
 */
export function collectArtifactReferences(payload: unknown): ArtifactReference[] {
  const found: ArtifactReference[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const parsed = artifactReferenceSchema.safeParse(value);
    if (parsed.success) {
      found.push(parsed.data);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) visit(item);
  };
  visit(payload);
  return found;
}
