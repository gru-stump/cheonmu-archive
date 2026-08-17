import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { DraftDetail, DraftVersion, NarrativeApi, ReviewInput } from '../../api/narrativeApi';
import { isArchiveSourceStatus, NarrativeApiError } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminSection } from '../../components/AdminSection';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';
import { formatKrw, formatSeoulTimestamp, microsToKrw } from '../../lib/narrativeDisplay';

type DialogKind = 'manual' | 'revision' | 'reject' | null;
const seoulDate = (value: string) => formatSeoulTimestamp(value).exact;
const kindLabels: Record<string, string> = {
  short_dialogue: '짧은 대화', daily_event: '일상 사건', major_event_proposal: '큰 사건 제안',
};
const statusLabels: Record<string, string> = {
  queued: '대기 중', generating: '만드는 중', generated: '검토 필요', reviewing: '검토 중',
  rejected: '거절됨', archived: '보관됨', approved_private: '비공개 승인', approved: '게시 승인',
  publishing: '게시 중', published: '공개 완료', publish_failed: '게시 실패',
};
const continuityLabels: Record<string, string> = {
  pass: '문제 없음', review: '확인 필요', block: '승인 불가',
};
const staleConflictCodes = new Set(['stale_review', 'stale_review_submission', 'stale_manual_version', 'stale_revision', 'stale_archive', 'stale_publish_retry', 'stale_restore', 'stale_reopen']);
const operationalConflictMessages: Record<string, string> = {
  stale_provider_pricing: '제공자 단가 확인일이 만료되었습니다. 설정에서 단가를 다시 확인해 주세요.',
  automation_disabled: '자동 생성이 꺼져 있습니다. 설정에서 자동 생성을 켜 주세요.',
  active_provider_setting_required: '활성 제공자 설정이 필요합니다. 설정에서 제공자를 선택해 주세요.',
  revision_cost_changed: '예상 비용이 변경되었습니다. 현재 단가로 다시 확인해 주세요.',
};

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

function publicationLink(detail: DraftDetail, kind: 'commit' | 'workflow' | 'pages'): string | null {
  const publication = detail.publication;
  const raw = publication?.[kind].url;
  if (!publication || !raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    const owner = publication.repositoryOwner;
    const repository = publication.repositoryName;
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) return null;
    if (kind === 'commit') {
      const sha = publication.commit.sha;
      const expected = sha && /^[0-9a-f]{40}$/i.test(sha) ? `/${owner}/${repository}/commit/${sha}` : '';
      return url.hostname === 'github.com' && url.pathname === expected ? url.href : null;
    }
    if (kind === 'workflow') {
      const runId = publication.workflow.runId;
      const expected = Number.isSafeInteger(runId) && Number(runId) > 0 ? `/${owner}/${repository}/actions/runs/${runId}` : '';
      return url.hostname === 'github.com' && url.pathname === expected ? url.href : null;
    }
    const host = `${owner.toLowerCase()}.github.io`;
    const path = repository.toLowerCase() === host ? '/' : `/${repository}/`;
    return url.hostname === host && url.pathname.toLowerCase().startsWith(path.toLowerCase()) ? url.href : null;
  } catch { return null; }
}

const workflowLabels = {
  pending: '사이트 만들기 대기', queued: '사이트 만들기 대기', in_progress: '사이트 만드는 중',
  success: '사이트 만들기 완료', failure: '사이트 만들기 실패', timed_out: '사이트 만들기 상태 확인 중단',
} as const;
const pagesLabels = {
  pending: '공개 배포 대기', queued: '공개 배포 대기', in_progress: '공개 사이트 배포 중',
  success: '공개 사이트 배포 완료', failure: '공개 사이트 배포 실패', timed_out: '공개 배포 상태 확인 중단',
} as const;

function PublicationStatus({ detail }: { detail: DraftDetail }) {
  const publication = detail.publication;
  if (!publication) return null;
  const commitUrl = publicationLink(detail, 'commit');
  const workflowUrl = publicationLink(detail, 'workflow');
  const pagesUrl = publicationLink(detail, 'pages');
  const commitLabel = publication.commit.status === 'created' ? '저장소 반영 완료' : publication.commit.status === 'failed' ? '저장소 반영 실패' : '저장소 반영 대기';
  return <section className="publication-status" role="region" aria-label="게시 진행 상태">
    <h2>게시 진행 상태</h2>
    <dl>
      <div><dt>저장소 반영</dt><dd>{commitLabel}{commitUrl && <> · <a href={commitUrl} target="_blank" rel="noreferrer noopener">변경 기록 보기</a></>}</dd></div>
      <div><dt>사이트 만들기</dt><dd>{workflowLabels[publication.workflow.status]}{workflowUrl && <> · <a href={workflowUrl} target="_blank" rel="noreferrer noopener">사이트 만들기 기록 보기</a></>}</dd></div>
      <div><dt>공개 사이트</dt><dd>{pagesLabels[publication.pages.status]}{pagesUrl && <> · <a href={pagesUrl} target="_blank" rel="noreferrer noopener">공개 사이트 열기</a></>}</dd></div>
    </dl>
  </section>;
}

export function DraftReviewPage({ api, draftId, readOnly = false, onRejected }: { api: NarrativeApi; draftId: string; readOnly?: boolean; onRejected?(reason: string): void }) {
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [manualText, setManualText] = useState('');
  const [selectedText, setSelectedText] = useState('');
  const [instruction, setInstruction] = useState('');
  const [confirmedRevisionSignature, setConfirmedRevisionSignature] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [problem, setProblem] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const load = async () => { setLoadError(false); try { const value = await api.getDraft(draftId); setDetail(value); setManualText(value.latestVersion.content.body); setStale(false); setProblem(false); setMessage(null); setConfirmedRevisionSignature(null); } catch { setLoadError(true); } };
  useEffect(() => { let active = true; void api.getDraft(draftId).then((value) => { if (active) { setDetail(value); setManualText(value.latestVersion.content.body); } }).catch(() => { if (active) setLoadError(true); }); return () => { active = false; }; }, [api, draftId]);
  const closeDialog = (preserveMessage = false) => { setDialog(null); setConfirmedRevisionSignature(null); setStale(false); if (!preserveMessage) { setProblem(false); setMessage(null); } queueMicrotask(() => triggerRef.current?.focus()); };
  const openDialog = (kind: Exclude<DialogKind, null>, event: React.MouseEvent<HTMLButtonElement>) => { triggerRef.current = event.currentTarget; setDialog(kind); setMessage(null); setStale(false); setProblem(false); setConfirmedRevisionSignature(null); };
  const handleConflict = (error: unknown) => {
    if (!(error instanceof NarrativeApiError) || error.status !== 409) return false;
    const isStale = staleConflictCodes.has(error.code);
    setStale(isStale); setProblem(true);
    setMessage(isStale ? '새 버전이 있습니다. 로컬 수정 내용은 유지됩니다. 새로 불러오세요.' : operationalConflictMessages[error.code] ?? '현재 설정과 요청 조건이 맞지 않습니다. 설정을 확인한 뒤 다시 시도해 주세요.');
    return true;
  };

  if (loadError) return <section><AdminPageHeader eyebrow="초안함" title="초안 검토" description="본문과 연속성 근거를 함께 검토합니다." /><AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>초안을 불러오지 못했습니다.</AdminNotice></section>;
  if (!detail) return <section><AdminPageHeader eyebrow="초안함" title="초안 검토" description="본문과 연속성 근거를 함께 검토합니다." /><AdminNotice>초안을 불러오는 중입니다.</AdminNotice></section>;
  const version = detail.latestVersion;
  const blocked = version.continuityLevel === 'block';
  const reviewable = detail.status === 'generated' || detail.status === 'reviewing';
  const mobileActionDisclosure = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 600px)').matches;
  const revisionOutputTokens = detail.revisionPricing?.maximumRevisionOutputTokens ?? 0;
  const estimatedRevisionCost = estimateRevisionCost(detail, revisionOutputTokens);
  const estimatedRevisionCostKrw = microsToKrw(estimatedRevisionCost, detail.revisionPricing?.krwPerUsd ?? 0);
  const revisionSignature = JSON.stringify({
    versionId: detail.latestVersionId,
    selectedText,
    instruction,
    requestedMaxOutputTokens: revisionOutputTokens,
    estimatedMaximumCostMicros: estimatedRevisionCost,
  });
  const costConfirmed = confirmedRevisionSignature === revisionSignature;
  const review = async (action: ReviewInput['action'], reviewReason?: string) => {
    setMessage(null); setProblem(false); setStale(false);
    try {
      const result = await api.review({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', action, ...(reviewReason ? { reason: reviewReason } : {}) });
      setDetail({ ...detail, status: result.status, ...(action === 'reject' && reviewReason ? { rejection: { reason: reviewReason, createdAt: new Date().toISOString() } } : {}) });
      if (action === 'reject' && reviewReason) { closeDialog(true); onRejected?.(reviewReason); return; }
      setMessage('검토 결과를 저장했습니다.'); closeDialog(true);
    } catch (error) { if (!handleConflict(error)) setMessage('요청을 처리하지 못했습니다.'); }
  };
  const saveManual = async (event: FormEvent) => {
    event.preventDefault(); setMessage(null); setProblem(false); setStale(false);
    try {
      const result = await api.saveManualVersion({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', content: { ...version.content, body: manualText } });
      if (result?.version) { const next = result.version; setDetail({ ...detail, status: 'reviewing', latestVersionId: next.id, latestVersion: next, versions: [...detail.versions, next] }); closeDialog(); }
      setMessage('새 버전을 저장했습니다.');
    } catch (error) { if (!handleConflict(error)) setMessage('새 버전을 저장하지 못했습니다.'); }
  };
  const revise = async (event: FormEvent) => {
    event.preventDefault(); setMessage(null); setProblem(false); setStale(false);
    const estimated = estimatedRevisionCost;
    if (!selectedText.trim() || !instruction.trim() || revisionOutputTokens < 1 || !costConfirmed) { setMessage('구절, 수정 지시와 최대 비용 확인이 필요합니다.'); return; }
    try {
      await api.generate({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status === 'generated' ? 'generated' : 'reviewing', mode: 'revise_selection', kind: detail.kind, revision: { selectedText, instruction }, requestedMaxOutputTokens: revisionOutputTokens, maximumCostConfirmed: true, confirmedMaximumCostMicros: estimated });
      closeDialog(); await load(); setMessage('부분 수정 결과를 새 버전으로 생성했습니다.');
    } catch (error) {
      if (error instanceof NarrativeApiError && error.code === 'provider_output_limit') {
        setProblem(true);
        setMessage('AI 답변 길이가 부족해 수정하지 못했습니다. 입력 내용은 유지했으니 다시 시도해 주세요.');
      } else if (!handleConflict(error)) setMessage('부분 수정에 실패했습니다.');
    }
  };
  const archive = async () => {
    if (!isArchiveSourceStatus(detail.status)) return;
    setMessage(null); setProblem(false); setStale(false);
    try { await api.archive({ draftId, expectedVersionId: detail.latestVersionId, expectedState: detail.status }); setDetail({ ...detail, status: 'archived' }); setMessage('초안을 보관했습니다.'); }
    catch (error) { if (!handleConflict(error)) setMessage('초안을 보관하지 못했습니다.'); }
  };
  const restore = async () => {
    if (detail.status !== 'archived') return;
    setMessage(null); setProblem(false); setStale(false);
    try { const result = await api.restore({ draftId, expectedVersionId: detail.latestVersionId }); setDetail({ ...detail, status: result.status }); setMessage(`초안을 ${result.status} 상태로 복원했습니다.`); }
    catch (error) { if (!handleConflict(error)) { setProblem(true); setMessage('초안을 복원하지 못했습니다.'); } }
  };
  const reopenRejected = async () => {
    if (detail.status !== 'rejected') return;
    setMessage(null); setProblem(false); setStale(false);
    try {
      await api.reopenRejected({ draftId, expectedVersionId: detail.latestVersionId });
      setDetail({ ...detail, status: 'reviewing' });
      setMessage('초안을 다시 검토할 수 있도록 열었습니다.');
    } catch (error) {
      if (!handleConflict(error)) { setProblem(true); setMessage('초안을 다시 열지 못했습니다.'); }
    }
  };
  const retryPublish = async () => {
    setMessage(null); setProblem(false); setStale(false);
    try { await api.retryPublish({ draftId, expectedVersionId: detail.latestVersionId, expectedState: 'publish_failed' }); setDetail({ ...detail, status: 'publishing' }); setMessage('게시를 다시 요청했습니다.'); }
    catch (error) { if (!handleConflict(error)) setMessage('게시 재시도를 요청하지 못했습니다.'); }
  };
  const reloadConflict = async () => { await load(); closeDialog(); };
  const conflictRecovery = stale && message
    ? <div className="conflict-recovery" role="alert"><p>{message}</p><button type="button" onClick={() => void reloadConflict()}>새로 불러오기</button></div>
    : message ? <p role={problem ? 'alert' : 'status'}>{message}</p> : null;

  return (
    <article className="draft-review">
      <AdminPageHeader eyebrow={kindLabels[detail.kind] ?? '이야기'} title={detail.title} description="이야기를 읽고 이어짐 문제가 없는지 확인한 뒤 승인합니다." action={<AdminStatusBadge tone={detail.status === 'rejected' || blocked ? 'danger' : detail.status === 'approved_private' ? 'plum' : 'green'}>{statusLabels[detail.status] ?? '상태 확인 필요'}</AdminStatusBadge>} />
      {detail.status === 'rejected' && <AdminNotice tone="info"><strong>거절 완료</strong> · 거절 사유가 다음 생성의 수정 지침에 반영됐습니다.{detail.rejection && <><p>{detail.rejection.reason}</p><time dateTime={detail.rejection.createdAt}>거절 {seoulDate(detail.rejection.createdAt)}</time></>}</AdminNotice>}
      {blocked && detail.status !== 'rejected' && <AdminNotice tone="danger"><strong>차단된 버전</strong> · {reviewable ? '이 버전은 사유를 남겨 거절만 할 수 있습니다.' : '검토가 종료되어 추가 작업을 할 수 없습니다.'}</AdminNotice>}
      {!dialog && message && <AdminNotice tone={stale || problem ? 'danger' : 'success'}>{message}</AdminNotice>}
      {!dialog && stale && <button type="button" onClick={() => void load()}>새로 불러오기</button>}
      <PublicationStatus detail={detail} />
      <div className="draft-review__layout">
        <section className="draft-reader" aria-labelledby="final-text"><h2 id="final-text">최종 본문</h2><pre className="draft-body">{version.content.body}</pre><span data-testid="reader-end" aria-hidden="true" /></section>
        <aside className="draft-review__rail" aria-label="검토 근거">
          <AdminSection title="이어짐 검사">{version.continuityFindings.length ? <ul className="finding-list">{version.continuityFindings.map((finding) => <li key={`${finding.code}-${finding.message}`}><strong>{finding.message}</strong><span>이어짐 {continuityLabels[finding.level] ?? '확인 필요'}</span>{finding.sourceIds.length > 0 && <span>참고한 기억: {finding.sourceIds.join(', ')}</span>}</li>)}</ul> : <p className="empty-copy">이어짐 문제 없음</p>}</AdminSection>
          <AdminSection title="참고한 이야기"><ul className="source-list">{version.contextVersionIds.map((id) => <li key={id}>{id}</li>)}</ul></AdminSection>
          <AdminSection title="새로 확정할 설정 후보">{version.content.canonChangeCandidates.length ? <ul>{version.content.canonChangeCandidates.map((candidate) => <li key={candidate}>{candidate}</li>)}</ul> : <p className="empty-copy">후보 없음</p>}</AdminSection>
        </aside>
      </div>
      <details className="version-history"><summary>버전 이력 · {detail.versions.length}개</summary><ol>{detail.versions.map((item: DraftVersion) => <li key={item.id}><strong>버전 {item.versionNumber}</strong> <time dateTime={item.createdAt}>{seoulDate(item.createdAt)}</time><p>{item.content.body}</p></li>)}</ol></details>
      <div className="review-actions" aria-label="초안 작업">
        {detail.status === 'archived' && <button className="button button--ink review-actions__primary" type="button" disabled={readOnly} onClick={() => void restore()}>복원</button>}
        {detail.status === 'rejected' && <button className="button button--ink review-actions__primary" type="button" disabled={readOnly} onClick={() => void reopenRejected()}>다시 검토하기</button>}
        {!blocked && reviewable && <button className="button button--primary review-actions__primary" type="button" disabled={readOnly} onClick={() => void review('approve_public')}>승인하고 게시</button>}
        {blocked && reviewable && <button className="button button--danger-outline review-actions__primary" type="button" disabled={readOnly} onClick={(event) => openDialog('reject', event)}>거절</button>}
        {!blocked && <details className="review-actions__more" open={!mobileActionDisclosure}><summary>작업</summary><div className="review-actions__secondary">
          {!blocked && reviewable && <button type="button" disabled={readOnly} onClick={(event) => openDialog('manual', event)}>직접 수정</button>}
          {!blocked && reviewable && <button type="button" disabled={readOnly} onClick={(event) => openDialog('revision', event)}>부분 AI 수정</button>}
          {!blocked && reviewable && <button className="button button--ink" type="button" disabled={readOnly} onClick={() => void review('approve_private')}>비공개 정사 승인</button>}
          {!blocked && isArchiveSourceStatus(detail.status) && <button className="button button--quiet" type="button" disabled={readOnly} onClick={() => void archive()}>보관</button>}
          {!blocked && detail.status === 'publish_failed' && <button type="button" disabled={readOnly} onClick={() => void retryPublish()}>게시 재시도</button>}
          {reviewable && <button className="button button--danger-text" type="button" disabled={readOnly} onClick={(event) => openDialog('reject', event)}>거절</button>}
        </div></details>}
      </div>
      {dialog === 'manual' && <Modal title="직접 수정" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={saveManual}><label htmlFor="manual-body">최종 본문</label><textarea id="manual-body" rows={12} value={manualText} onChange={(event) => setManualText(event.target.value)} required /><button type="submit">새 버전 저장</button></form></Modal>}
      {dialog === 'revision' && <Modal title="부분 AI 수정" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={revise}><label htmlFor="selected-text">선택한 구절</label><textarea id="selected-text" value={selectedText} onChange={(event) => { setSelectedText(event.target.value); setConfirmedRevisionSignature(null); }} required /><label htmlFor="revision-instruction">수정 지시</label><textarea id="revision-instruction" value={instruction} onChange={(event) => { setInstruction(event.target.value); setConfirmedRevisionSignature(null); }} required /><p>AI가 필요한 답변 길이는 모델에 맞게 자동으로 정합니다.</p><p>최대 예상 비용: {formatKrw(estimatedRevisionCostKrw)}</p><label><input type="checkbox" checked={costConfirmed} onChange={(event) => setConfirmedRevisionSignature(event.target.checked ? revisionSignature : null)} /> 최대 비용을 확인했습니다</label><button type="submit">새 버전 생성</button></form></Modal>}
      {dialog === 'reject' && <Modal title="거절" onClose={() => closeDialog()}>{conflictRecovery}<form onSubmit={(event) => { event.preventDefault(); void review('reject', reason); }}><label htmlFor="reject-reason">거절 사유</label><textarea id="reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} required /><button type="submit">거절 확정</button></form></Modal>}
    </article>
  );
}
