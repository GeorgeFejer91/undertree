export const MINIMUM_TREE_HEIGHT = 150;
export const MINIMUM_OUTLINE_HEIGHT = 130;

export function clampTreeHeight(
  requestedHeight,
  availableHeight,
  minimumTreeHeight = MINIMUM_TREE_HEIGHT,
  minimumOutlineHeight = MINIMUM_OUTLINE_HEIGHT,
) {
  const maximumTreeHeight = Math.max(minimumTreeHeight, availableHeight - minimumOutlineHeight);
  return Math.max(minimumTreeHeight, Math.min(maximumTreeHeight, requestedHeight));
}
