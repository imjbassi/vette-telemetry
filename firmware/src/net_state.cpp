#include "net_common.h"

namespace net {

Fix fix() {
  portENTER_CRITICAL(&state::mux);
  Fix f = state::fix;
  portEXIT_CRITICAL(&state::mux);
  return f;
}

uint8_t csq() { return state::csq; }

uint32_t epochBase() {
  portENTER_CRITICAL(&state::mux);
  uint32_t e = state::epochBase;
  portEXIT_CRITICAL(&state::mux);
  return e;
}

}  // namespace net
