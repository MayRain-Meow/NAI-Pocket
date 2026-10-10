// Run one storage program with either immediate Node results or native promises.
// Synchronous drivers never cross a promise boundary inside a SQLite transaction.

export function runSteps(iterator) {
  function resume(method, value) {
    for (;;) {
      const step = iterator[method](value);
      if (step.done) return step.value;
      if (step.value && typeof step.value.then === 'function') {
        return step.value.then(value => resume('next', value), error => resume('throw', error));
      }
      method = 'next'; value = step.value;
    }
  }
  return resume('next');
}

export const flow = program => function (...args) { return runSteps(program.apply(this, args)); };
