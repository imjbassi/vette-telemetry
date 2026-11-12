#pragma once
// A stand-in for the Arduino core, just large enough to build src/pids.cpp on a PC.
// Only test/host/test_pids.cpp uses it. It is never part of a firmware build.
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

// The parts of Arduino's String that pids.cpp calls, with the same results.
class String {
 public:
  String() {}
  String(const char* s) : m(s ? s : "") {}
  explicit String(const std::string& s) : m(s) {}

  unsigned int length() const { return (unsigned int)m.size(); }
  const char* c_str() const { return m.c_str(); }
  char operator[](unsigned int i) const { return i < m.size() ? m[i] : 0; }

  int indexOf(char c, unsigned int from = 0) const {
    size_t p = m.find(c, from);
    return p == std::string::npos ? -1 : (int)p;
  }
  int indexOf(const char* s, unsigned int from = 0) const {
    size_t p = m.find(s, from);
    return p == std::string::npos ? -1 : (int)p;
  }
  String substring(unsigned int from) const { return substring(from, length()); }
  String substring(unsigned int from, unsigned int to) const {
    if (from > to) std::swap(from, to);
    if (from >= m.size()) return String();
    if (to > m.size()) to = (unsigned int)m.size();
    return String(m.substr(from, to - from));
  }
  bool startsWith(const char* p) const { return m.compare(0, std::strlen(p), p) == 0; }
  void replace(const char* from, const char* to) {
    size_t n = std::strlen(from);
    if (!n) return;
    for (size_t p = m.find(from); p != std::string::npos; p = m.find(from, p + std::strlen(to))) m.replace(p, n, to);
  }
  void toUpperCase() {
    for (auto& c : m) c = (char)std::toupper((unsigned char)c);
  }
  void trim() {
    size_t a = 0, b = m.size();
    while (a < b && std::isspace((unsigned char)m[a])) a++;
    while (b > a && std::isspace((unsigned char)m[b - 1])) b--;
    m = m.substr(a, b - a);
  }
  float toFloat() const { return (float)std::atof(m.c_str()); }

  String& operator+=(const char* s) { m += s; return *this; }
  String& operator+=(const String& s) { m += s.m; return *this; }
  friend String operator+(const String& a, const String& b) { return String(a.m + b.m); }
  friend String operator+(const String& a, char b) { return String(a.m + b); }

 private:
  std::string m;
};

// Log lines go nowhere.
struct SerialShim {
  void printf(const char*, ...) {}
  void println(const char*) {}
};
inline SerialShim Serial;

// The clock. The test sets it.
inline uint32_t g_millis = 0;
inline uint32_t millis() { return g_millis; }
