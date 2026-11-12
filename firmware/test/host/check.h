#pragma once
#include <cstdio>

// The whole test framework. CHECK counts and prints a failed condition with its place.
// Each test file is its own program and ends with `return finish("name");`.
static int g_checks = 0;
static int g_failed = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    g_checks++;                                                              \
    if (!(cond)) {                                                           \
      g_failed++;                                                            \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                        \
  } while (0)

// Like CHECK(a == b) for whole numbers, and prints both values when they differ.
#define CHECK_EQ(a, b)                                                       \
  do {                                                                       \
    g_checks++;                                                              \
    long long va_ = (long long)(a), vb_ = (long long)(b);                    \
    if (va_ != vb_) {                                                        \
      g_failed++;                                                            \
      std::printf("  FAIL %s:%d  %s == %s  (%lld vs %lld)\n", __FILE__, __LINE__, #a, #b, va_, vb_); \
    }                                                                        \
  } while (0)

static inline int finish(const char* name) {
  std::printf("%s: %d checks, %d failed\n", name, g_checks, g_failed);
  return g_failed ? 1 : 0;
}
