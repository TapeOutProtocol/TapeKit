import { t } from '../i18n';
import { IconBack } from '../icons';
import { type Endpoint, type Message, type OpenedMessage, chainName, replySubject } from '../data/tapesend';
import { useLabel } from './MessageList';

export function MessageReader({ message, me, opened, muted, onClose, onReply, onMute }: {
  message: Message;
  me: Endpoint;
  opened: OpenedMessage;
  muted: boolean;
  onClose: () => void;
  /** 电路合约被更换时不给回复 */
  onReply?: (peerAddress: string, subject: string) => void;
  onMute: (muted: boolean) => void;
}) {
  const fromLabel = useLabel(message.fromEndpoint);
  const toLabel = useLabel(message.toEndpoint);
  const when = new Date(message.timestamp * 1000).toLocaleString();
  const subject = opened.status === 'ok' && opened.subject ? opened.subject : '';

  return (
    <div className="sheet" role="dialog" aria-label={subject || fromLabel}>
      <div className="sheet-head">
        <button className="icon-btn" onClick={onClose} aria-label={t('back')}><IconBack /></button>
        <span className="grow" />
        {message.direction === 'in' ? (
          <button className="btn small" onClick={() => onMute(!muted)}>{muted ? t('unmute') : t('mute')}</button>
        ) : null}
        {message.direction === 'in' && onReply ? (
          // 回复收件人用完整容器地址（解析失败时标签只是缩写），主题用原始文字
          <button className="btn small" onClick={() => onReply(message.from, replySubject(opened.status === 'ok' ? opened.rawSubject ?? '' : ''))}>
            {t('reply')}
          </button>
        ) : null}
      </div>
      <div className="scroll">
        <article className="page reader">
          {!me.factory.circuitsIntact ? <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>{t('circuitsChanged')}</div> : null}
          <h1>{subject || (opened.status === 'ok' ? '' : '—')}</h1>
          <dl className="meta">
            <dt>{t('from')}</dt>
            <dd className="mono" title={message.from}>{fromLabel}</dd>
            <dt>{t('to')}</dt>
            <dd className="mono" title={message.to}>{toLabel}</dd>
            <dt>{t('time')}</dt>
            <dd>
              {when}
              {message.pending ? ` ${t('pending')}` : ''}
            </dd>
            <dt>{t('tx')}</dt>
            <dd className="mono">
              <a href={`https://bscscan.com/block/${message.blockNumber}`} target="_blank" rel="noopener noreferrer">
                {chainName(message.chainId)} #{message.blockNumber}
              </a>
            </dd>
          </dl>
          {opened.status === 'ok' ? (
            <>
              {opened.kind === 'public' ? <div className="notice warn" style={{ marginBottom: 12 }}>{t('publicWarnTitle')}</div> : null}
              <div className="body">{opened.body}</div>
            </>
          ) : (
            <div className="notice">
              {opened.status === 'locked' ? t('locked') : opened.status === 'not-for-key' ? t('notForKey') : opened.status === 'unsupported' ? t('unsupported') : t('damaged')}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
