// npm registry: resolve a version, fetch its tarball descriptor, and check the provenance claim.
import { config } from './config.js';
import { IngestError, fetchJson } from './util.js';

export interface PackumentVersion {
  version: string;
  homepage?: string;
  repository?: { type?: string; url?: string } | string;
  dist: { tarball: string; integrity?: string; shasum?: string; attestations?: { url: string; provenance?: { predicateType: string } } };
  exports?: Record<string, unknown>;
}
export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackumentVersion>;
  time?: Record<string, string>;
}

export async function fetchPackument(name = config.packageName): Promise<Packument> {
  const p = await fetchJson<Packument>(`${config.registry}/${encodeURIComponent(name)}`);
  if (!p) throw new IngestError(`package ${name} not found on ${config.registry}`);
  return p;
}

/** Exact version, or a dist-tag such as `latest`. */
export function resolveVersion(packument: Packument, spec: string): PackumentVersion {
  const version = packument.versions[spec] ? spec : packument['dist-tags'][spec];
  const v = version ? packument.versions[version] : undefined;
  if (!v) throw new IngestError(`${packument.name}@${spec}: no such version or dist-tag (have ${Object.keys(packument['dist-tags']).join(', ')})`);
  return v;
}

export interface Provenance {
  /** `claim-verified`: the SLSA statement names the expected repository. Signatures are NOT verified here. */
  status: 'claim-verified' | 'mismatch' | 'none';
  repository?: string;
  workflow?: string;
  ref?: string;
  commit?: string;
  runUrl?: string;
  attestationsUrl: string;
  detail?: string;
}

interface AttestationBundle {
  predicateType: string;
  bundle: { dsseEnvelope: { payload: string } };
}

/**
 * Read the SLSA provenance statement attached to the version and check it names the expected
 * repository. This is a *claim* check: it proves what the statement says, not that the statement
 * is signed. Full Sigstore verification is `npm audit signatures` territory (or sigstore-js) and can
 * be added behind the same interface.
 */
export async function checkProvenance(name: string, version: string, expectedRepo = config.repository): Promise<Provenance> {
  const attestationsUrl = `${config.registry}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
  const res = await fetchJson<{ attestations?: AttestationBundle[] }>(attestationsUrl, { optional: true });
  const slsa = res?.attestations?.find((a) => a.predicateType.startsWith('https://slsa.dev/provenance/'));
  if (!slsa) return { status: 'none', attestationsUrl, detail: 'no SLSA provenance attestation on the registry' };

  const statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
    predicate?: {
      buildDefinition?: {
        externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } };
        resolvedDependencies?: Array<{ uri?: string; digest?: { gitCommit?: string } }>;
      };
      runDetails?: { metadata?: { invocationId?: string } };
    };
  };
  const wf = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const dep = statement.predicate?.buildDefinition?.resolvedDependencies?.[0];
  const repository = wf?.repository?.replace(/^https:\/\/github\.com\//, '');
  const result: Provenance = {
    status: repository === expectedRepo ? 'claim-verified' : 'mismatch',
    repository,
    workflow: wf?.path,
    ref: wf?.ref,
    commit: dep?.digest?.gitCommit,
    runUrl: statement.predicate?.runDetails?.metadata?.invocationId,
    attestationsUrl,
  };
  if (result.status === 'mismatch') result.detail = `attestation names ${repository ?? 'no repository'}, expected ${expectedRepo}`;
  return result;
}
