// The worker: the base image's entrypoint. It watches /work_queue for job
// directories, runs `sh run.sh` in each, and moves it to .done with a
// result.json. Flags first, then the environment `up` passes in.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	host, _ := os.Hostname()
	queue := flag.String("queue", envOr("WORK_QUEUE", "/work_queue"), "the directory to watch")
	name := flag.String("name", envOr("WORKER", host), "this worker's name, written into claim.json and result.json")
	workers := flag.String("workers", envOr("WORKERS", "1"), "how many jobs run at once")
	poll := flag.String("poll", envOr("POLL", "2s"), "how often the queue and the cancel files are looked at")
	timeout := flag.String("timeout", envOr("TIMEOUT", "1h"), "the default job timeout; 0 for none")
	flag.Parse()

	n, err := strconv.Atoi(*workers)
	if err != nil || n < 1 {
		fmt.Fprintf(os.Stderr, "worker: --workers must be a positive number, not %q\n", *workers)
		os.Exit(2)
	}
	p, err := time.ParseDuration(*poll)
	if err != nil || p <= 0 {
		fmt.Fprintf(os.Stderr, "worker: --poll must be a duration like 2s, not %q\n", *poll)
		os.Exit(2)
	}
	t, err := time.ParseDuration(*timeout)
	if err != nil || t < 0 {
		fmt.Fprintf(os.Stderr, "worker: --timeout must be a duration like 1h, not %q\n", *timeout)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	logger.Printf("worker %s watching %s, %d at a time, every %s, timeout %s", *name, *queue, n, p, t)
	if err := Run(ctx, Config{Queue: *queue, Name: *name, Workers: n, Poll: p, Timeout: t, Log: logger}); err != nil {
		fmt.Fprintf(os.Stderr, "worker: %v\n", err)
		os.Exit(1)
	}
}
