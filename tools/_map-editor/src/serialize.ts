// The editor's export: a map object back to YAML. This is the editor's own
// serialization, not the map's contract, which is why it stays here rather
// than in architect.
import { stringify } from 'yaml'

/** Serialize a map object to YAML (multiline strings become literal blocks). */
export function mapToYaml(map: unknown): string {
  return stringify(map, { lineWidth: 100 })
}
