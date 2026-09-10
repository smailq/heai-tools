// A concurrency cap: jobs run in the order they were queued, up to
// `concurrency` at once. Every action is its own job; nothing here orders
// one job after another.

export class Pool {
  private readonly concurrency: number
  private readonly queue: Array<() => Promise<void>> = []
  private active = 0
  private readonly idlers: Array<() => void> = []

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency)
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => fn().then(resolve, reject))
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      this.active++
      void job().finally(() => {
        this.active--
        this.pump()
      })
    }
    if (!this.active && !this.queue.length) for (const fn of this.idlers.splice(0)) fn()
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve()
    return new Promise((resolve) => this.idlers.push(resolve))
  }
}
