export function createOperationGeneration(staleMessage: string) {
  let generation = 0;

  return {
    begin() {
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
    },
    throwIfStale(operationGeneration: number) {
      if (operationGeneration !== generation) {
        throw new DOMException(staleMessage, "AbortError");
      }
    },
  };
}
