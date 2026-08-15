import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { DraftDetail, DraftVersion, NarrativeApi, ReviewInput } from '../../api/narrativeApi';
import { isArchiveSourceStatus, NarrativeApiError } from '../../api/narrativeApi';

type DialogKind = 'manual' | 'revision' | 'reject' | null;
const seoulDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('textarea, input, button');
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button, input, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter((node) => !node.hasAttribute('disabled'));
      if (focusable.length === 0) return;
      const firstNode = focusable[0]; const lastNode = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) { event.preventDefault(); lastNode.focus(); }
      else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); firstNode.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  return <div className="modal-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="modal"><h2 id="dialog-title">{title}</h2>{children}<button type="button" onClick={onClose}>닫기</button></div></div>;
}

function estimateRevisionCost(detail: DraftDetail, outputTokens: number): number {
  const pricing = detail.revisionPricing;
  if (!pricing) return 0;
  const boundedOutput = Math.min(outputTokens, pricing.maximumRevisionOutputTokens);
  return pricing.fixedCostMicros + Math.ceil(pricing.maximumInputTokens * pricing.inputCostMicrosPerMillion / 1_000_000) + Math.ceil(boundedOutput * pricing.outputCostMicrosPerMillion / 1_000_000);
}

export function DraftReviewPage({ api, draftId }: { api: NarrativeApi; draftId: string }) {
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [manualText, setManualText] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [maxTokens, setMaxTokens] = useState(128);
  const [confirmedRevisionSignature, setConfirmedRevisionSignature] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const load = async () => { setLoadError(false); const value = await api.getDraft(draftId); setDetail(value); setManualText(value.latestVersion.content.body); setStale(false); setMessage(null); setConfirmedRevisionSignature(null); };
  useEffect(() => { let active = true; void api.getDraft(draftId).then((value) => { if (active) { setDetail(value); setManualText(value.latestVersion.content.body); } }).catch(() => { if (active) setLoadError(true); }); return () => { active = false; }; }, [api, draftId]);
  const closeDialog = (preserveMessage = false) => { setDialog(null); setConfirmedRevisionSignature(null); setStale(false); if (!preserveMessage) setMessage(null); queueMicrotask(() => triggerRef.current?.focus()); };
  const openDialog = (kind: Exclude<DialogKind, null>, event: React.MouseEvent<HTMLButtonElement>) => { triggerRef.current = event.currentTarget; setDialog(kind); setMessage(null); setStale(false); setConfirmedRevisionSignature(null); };
  const handleConflict = (error: unknown) => { if (error instanceof NarrativeApiError && error.status === 409) { setStale(true); setMessage('새 버전이 있습니다. 로컬 수정 내용은 유지됩니다. 새로 불러오세요.'); return true; } return false; };

  if (loadError) return <section><h1>초안 검토</h1><p role="alert">초안을 불러오지 못했습니다.</p></section>;
  if (!detail) return <section><h1>초안 검토</h1><p role="status">초안을 불러오는 중입니다.</p></section>;
  const version = detail.latestVersion;
  const blocked = version.continuityLevel === 'block';
  const reviewable = detail.status === 'generated' || detail.status === 'reviewing';
  const estimatedRevisionCost = estimateRevisionCost(detail, maxTokens);
  const revisionSignature = JSON.stringify({
    versionId: detail.latestVersionId,
    selectedText,
    instruction,
    maxTokens,
    estimatedMaximumCostMicros: estimatedRevisionCost,
  });
  const costConfirmed = confirmedRevisionSignature === revisionSignature;
  const review = async (action: ReviewInput['action'], reviewReason?: string) => {
    setMessage(null);
    try {
      const result = await api.review({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', action, ...(reviewReason ? { reason: reviewReason } : {}) });
      setDetail({ ...detail, status: result.status }); setMessage('검토 결과를 저장했습니다.'); closeDialog(true);
    } catch (error) { if (!handleConflict(error)) setMessage('요청을 처리하지 못했습니다.'); }
  };
  const saveManual = async (event: FormEvent) => {
    event.preventDefault(); setMessage(null);
    try {
      const result = await api.saveManualVersion({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', content: { ...version.content, body: manualText } });
      if (result?.version) { const next = result.version; setDetail({ ...detail, status: 'reviewing', latestVersionId: next.id, latestVersion: next, versions: [...detail.versions, next] }); closeDialog(); }
      setMessage('새 버전을 저장했습니다.');
    } catch (error) { if (!handleConflict(error)) setMessage('새 버전을 저장하지 못했습니다.'); }
  };
  const revise = async (event: FormEvent) => {
    event.preventDefault(); setMessage(null);
    const estimated = estimatedRevisionCost;
    if (!selectedText.trim() || !instruction.trim() || maxTokens < 1 || !costConfirmed) { setMessage('구절, 수정 지시, 최대 토큰과 비용 확인이 필요합니다.'); return; }
    try {
      await api.generate({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', mode: 'revise_selection', kind: detail.kind, revision: { selectedText, instruction }, requestedMaxOutputTokens: maxTokens, maximumCostConfirmed: true, confirmedMaximumCostMicros: estimated });
      closeDialog(); await load(); setMessage('부분 수정 결과를 새 버전으로 생성했습니다.');
    } catch (error) { if (!handleConflict(error)) setMessage('부분 수정에 실패했습니다.'); }
  };
  const archive = async () => {
    if (!isArchiveSourceStatus(detail.status)) return;
    setMessage(null);
    try { await api.archive({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status }); setDetail({ ...detail, status: 'archived' }); setMessage('초안을 보관했습니다.'); }
    catch (error) { if (!handleConflict(error)) setMessage('초안을 보관하지 못했습니다.'); }
  };
  const retryPublish = async () => {
    setMessage(null);
    try { await api.retryPublish({ draftId, expectedVersionId: detail.latestVersionId, expectedState: 'publish_failed' }); setDetail({ ...detail, status: 'publishing' }); setMessage('게시를 다시 요청했습니다.'); }
    catch (error) { if (!handleConflict(error)) setMessage('게시 재시도를 요청하지 못했습니다.'); }
  };
  const reloadConflict = async () => { await load(); closeDialog(); };
  const conflictRecovery = stale && message
    ? <div className="conflict-recovery" role="alert"><p>{message}</p><button type="button" onClick={() => void reloadConflict()}>새로 불러오기</button></div>
    : message ? <p role="status">{message}</p> : null;

  return (
    <article aria-labelledby="draft-title">
      <header><p>{detail.kind} · {detail.status}</p><h1 id="draft-title">{detail.title}</h1>{blocked && <p className="blocked-notice">차단된 버전</p>}</header>
      {!dialog && message && <p role={stale ? 'alert' : 'status'}>{message}</p>}
      {!dialog && stale && <button type="button" onClick={() => void load()}>새로 불러오기</button>}
      <section aria-labelledby="final-text"><h2 id="final-text">최종 본문</h2><pre className="draft-body">{version.content.body}</pre></section>
      <section aria-labelledby="findings"><h2 id="findings">자동 검사</h2>{version.continuityFindings.length ? <ul>{version.continuityFindings.map((finding) => <li key={`${finding.code}-${finding.message}`}><strong>{finding.message}</strong><span>{finding.code} · {finding.level}</span>{finding.sourceIds.length > 0 && <span>출처: {finding.sourceIds.join(', ')}</span>}</li>)}</ul> : <p>검사 결과 없음</p>}</section>
      <section aria-labelledby="context"><h2 id="context">사용한 문맥 버전</h2><ul>{version.contextVersionIds.map((id) => <li key={id}>{id}</li>)}</ul></section>
      <section aria-labelledby="canon-candidates"><h2 id="canon-candidates">정사 변경 후보</h2>{version.content.canonChangeCandidates.length ? <ul>{version.content.canonChangeCandidates.map((candidate) => <li key={candidate}>{candidate}</li>)}</ul> : <p>후보 없음</p>}</section>
      <section aria-labelledby="history"><h2 id="history">버전 이력</h2><ol>{detail.versions.map((item: DraftVersion) => <li key={item.id}><strong>버전 {item.versionNumber}</strong> <time dateTime={item.createdAt}>{seoulDate(item.createdAt)}</time><p>{item.content.body}</p></li>)}</ol></section>
      <div className="review-actions" aria-label="초안 작업">
        {!blocked && reviewable && <button type="button" onClick={(event) => openDialog('manual', event)}>직접 수정</button>}
        {!blocked && reviewable && <button type="button" onClick={(event) => openDialog('revision', event)}>부분 AI 수정</button>}
        {!blocked && reviewable && <button type="button" onClick={() => void review('approve_private')}>비공개 정사 승인</button>}
        {!blocked && reviewable && <button type="button" onClick={() => void review('approve_public')}>승인하고 게시</button>}
        {(reviewable || blocked) && <button type="button" onClick={(event) => openDialog('reject', event)}>거절</button>}
        {!blocked && isArchiveSourceStatus(detail.status) && <button type="button" onClick={() => void archive()}>보관</button>}
        {!blocked && detail.status === 'publish_failed' && <button type="button" onClick={() => void retryPublish()}>게시 재시도</button>}
      </div>
      {dialog === 'manual' && <Modal title="직접 수정" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={saveManual}><label htmlFor="manual-body">최종 본문</label><textarea id="manual-body" rows={12} value={manualText} onChange={(event) => setManualText(event.target.value)} required /><button type="submit">새 버전 저장</button></form></Modal>}
      {dialog === 'revision' && <Modal title="부분 AI 수정" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={revise}><label htmlFor="selected-text">선택한 구절</label><textarea id="selected-text" value={selectedText} onChange={(event) => { setSelectedText(event.target.value); setConfirmedRevisionSignature(null); }} required /><label htmlFor="revision-instruction">수정 지시</label><textarea id="revision-instruction" value={instruction} onChange={(event) => { setInstruction(event.target.value); setConfirmedRevisionSignature(null); }} required /><label htmlFor="max-tokens">최대 출력 토큰</label><input id="max-tokens" type="number" min="1" max={detail.revisionPricing?.maximumRevisionOutputTokens ?? 4096} value={maxTokens} onChange={(event) => { setMaxTokens(Number(event.target.value)); setConfirmedRevisionSignature(null); }} required /><p>예상 최대 비용: {estimatedRevisionCost.toLocaleString('en-US')} μUSD</p><label><input type="checkbox" checked={costConfirmed} onChange={(event) => setConfirmedRevisionSignature(event.target.checked ? revisionSignature : null)} /> 최대 비용을 확인했습니다</label><button type="submit">새 버전 생성</button></form></Modal>}
      {dialog === 'reject' && <Modal title="거절" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={(event) => { event.preventDefault(); void review('reject', reason); }}><label htmlFor="reject-reason">거절 사유</label><textarea id="reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} required /><button type="submit">거절 확정</button></form></Modal>}
    </article>
  );
}
