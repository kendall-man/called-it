export const superviseStack = (children, { onUnexpectedExit }) => {
  let stopping = false;
  const terminate = (excluded) => {
    for (const child of children) {
      if (child !== excluded) child.kill('SIGTERM');
    }
  };
  for (const child of children) {
    child.on('exit', (code) => {
      if (stopping) return;
      stopping = true;
      onUnexpectedExit(code ?? 1);
      terminate(child);
    });
  }
  return () => {
    if (stopping) return;
    stopping = true;
    terminate(null);
  };
};
