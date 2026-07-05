import { describe, expect, it } from 'vitest';
import { normalizeAirbnbCookiesToDotCom } from '../src/endpoints/inject-cookies';

type Cookie = Parameters<typeof normalizeAirbnbCookiesToDotCom>[0][number];

function ck(name: string, domain: string, extra: Partial<Cookie> = {}): Cookie {
  return { name, value: `v_${name}`, domain, path: '/', ...extra };
}

const domainsFor = (out: Cookie[], name: string) =>
  out.filter((c) => c.name === name).map((c) => c.domain).sort();

describe('normalizeAirbnbCookiesToDotCom', () => {
  it('promotes a .ca-scoped _aat to also cover .airbnb.com', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', '.airbnb.ca', { httpOnly: true, secure: true }),
      ck('_airbed_session_id', '.airbnb.ca'),
    ]);
    expect(domainsFor(out, '_aat')).toEqual(['.airbnb.ca', '.airbnb.com']);
    expect(domainsFor(out, '_airbed_session_id')).toEqual(['.airbnb.ca', '.airbnb.com']);
    // Attributes carried onto the promoted copy.
    const promoted = out.find((c) => c.name === '_aat' && c.domain === '.airbnb.com');
    expect(promoted).toMatchObject({ httpOnly: true, secure: true, value: 'v__aat' });
  });

  it('handles any country TLD, incl. multi-label (.co.uk, .com.au)', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', '.airbnb.co.uk'),
      ck('_airbed_session_id', 'airbnb.com.au'),
    ]);
    expect(domainsFor(out, '_aat')).toContain('.airbnb.com');
    expect(domainsFor(out, '_airbed_session_id')).toContain('.airbnb.com');
  });

  it('does NOT duplicate cookies already scoped to .airbnb.com', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', '.airbnb.com'),
      ck('bev', '.www.airbnb.com'),
      ck('muxData', 'www.airbnb.com'),
    ]);
    // No new entries added; count unchanged.
    expect(out).toHaveLength(3);
    expect(domainsFor(out, '_aat')).toEqual(['.airbnb.com']);
  });

  it('native .airbnb.com value wins — a .ca copy of the same name is NOT promoted over it', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', '.airbnb.com', { value: 'native_com' }),
      ck('_aat', '.airbnb.ca', { value: 'ca_stale' }),
    ]);
    const comVals = out.filter((c) => c.name === '_aat' && c.domain === '.airbnb.com').map((c) => c.value);
    expect(comVals).toEqual(['native_com']); // exactly one .com _aat, the native one
  });

  it('promotes only the FIRST country-TLD cookie of a name (deterministic, no double-add)', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', '.airbnb.ca', { value: 'ca' }),
      ck('_aat', '.airbnb.co.uk', { value: 'uk' }),
    ]);
    const comCopies = out.filter((c) => c.name === '_aat' && c.domain === '.airbnb.com');
    expect(comCopies).toHaveLength(1);
    expect(comCopies[0].value).toBe('ca');
  });

  it('does NOT promote a lookalike domain (airbnb.com.evil.com) onto .airbnb.com', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('_aat', 'airbnb.com.evil.com', { value: 'attacker' }),
      ck('_airbed_session_id', '.airbnb.ca'),
    ]);
    // The lookalike stays on its own domain; only the real .ca cookie promotes.
    expect(out.filter((c) => c.domain === '.airbnb.com')).toHaveLength(1);
    expect(domainsFor(out, '_aat')).toEqual(['airbnb.com.evil.com']);
  });

  it('leaves non-Airbnb cookies untouched', () => {
    const out = normalizeAirbnbCookiesToDotCom([
      ck('session', '.datadome.co'),
      ck('_ga', '.google.com'),
      ck('_aat', '.airbnb.ca'),
    ]);
    expect(domainsFor(out, 'session')).toEqual(['.datadome.co']);
    expect(domainsFor(out, '_ga')).toEqual(['.google.com']);
    expect(out.filter((c) => c.domain === '.airbnb.com')).toHaveLength(1); // only _aat promoted
  });

  it('is a no-op for an all-.com jar (idempotent shape)', () => {
    const input = [ck('_aat', '.airbnb.com'), ck('_airbed_session_id', '.airbnb.com')];
    const once = normalizeAirbnbCookiesToDotCom(input);
    const twice = normalizeAirbnbCookiesToDotCom(once);
    expect(twice).toHaveLength(once.length);
    expect(once).toHaveLength(2);
  });
});
