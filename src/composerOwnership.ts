export type ComposerOwner = {
  activeId: string | null;
  epoch: number;
};

export function isCurrentComposerOwner(
  owner: ComposerOwner,
  activeId: string | null,
  epoch: number,
): boolean {
  return owner.activeId === activeId && owner.epoch === epoch;
}

export function canClearStashedComposer(input: {
  owner: ComposerOwner;
  activeId: string | null;
  epoch: number;
  capturedDraft: string;
  currentDraft: string;
  capturedAttachmentIds: readonly string[];
  currentAttachmentIds: readonly string[];
}): boolean {
  return (
    isCurrentComposerOwner(input.owner, input.activeId, input.epoch) &&
    input.capturedDraft === input.currentDraft &&
    input.capturedAttachmentIds.length === input.currentAttachmentIds.length &&
    input.capturedAttachmentIds.every(
      (id, index) => id === input.currentAttachmentIds[index],
    )
  );
}
