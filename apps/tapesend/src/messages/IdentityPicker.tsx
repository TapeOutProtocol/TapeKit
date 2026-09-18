import { useState } from 'react';
import { t } from '../i18n';
import { type Endpoint, type Hex, rememberIdentity, resolveEndpoint, savedIdentities } from '../data/tapesend';

export function IdentityPicker({ wallet, onPick, onCancel }: { wallet: Hex; onPick: (ep: Endpoint) => void; onCancel?: () => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saved = savedIdentities(wallet);

  const choose = async (raw: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await resolveEndpoint(raw);
      if (!r.endpoint) {
        setError(t('recipientBad'));
        return;
      }
      if (r.endpoint.holder?.toLowerCase() !== wallet.toLowerCase()) {
        setError(t('notHolder'));
        return;
      }
      if (!r.endpoint.opened) {
        setError(t('notOpened'));
        return;
      }
      rememberIdentity(wallet, r.endpoint.label);
      onPick(r.endpoint);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setError(code === 'hub-missing' ? t('hubNotDeployed') : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scroll">
      <div className="page">
        <h2 style={{ margin: '12px 0 6px' }}>{t('identityTitle')}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{t('identityText')}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void choose(input);
          }}
        >
          <div className="field">
            <input
              className="input mono"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('toPlaceholder')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={t('identityTitle')}
            />
            {busy ? <span className="hint">{t('identityChecking')}</span> : null}
            {error ? <span className="hint bad" role="alert">{error}</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy || !input.trim()}>{t('identityAdd')}</button>
            {onCancel ? <button type="button" className="btn" onClick={onCancel}>{t('cancel')}</button> : null}
          </div>
        </form>
        {saved.length ? (
          <ul className="row-list">
            {saved.map((label) => (
              <li key={label}>
                <button className="row-btn" disabled={busy} onClick={() => void choose(label)}>
                  <span className="grow mono">{label}</span>
                  <span className="hint">›</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
