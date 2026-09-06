#include "core/activitylog.hpp"

#include <cstdio>
#include <ctime>

namespace rackmcp {

std::string clampChatText(const std::string& text) {
    if (text.size() <= CHAT_MAX_TEXT_BYTES)
        return text;
    size_t cut = CHAT_MAX_TEXT_BYTES;
    while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80)
        cut--;
    // Walk back off any continuation bytes (10xxxxxx) so the result never ends
    // mid-sequence. At most three steps, since a UTF-8 sequence is <= 4 bytes.

    return text.substr(0, cut);
}

std::string clockNow() {
    std::time_t now = std::time(NULL);
    std::tm tm;
#ifdef _WIN32
    localtime_s(&tm, &now);
#else
    localtime_r(&now, &tm);
#endif
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%02d:%02d:%02d", tm.tm_hour, tm.tm_min, tm.tm_sec);
    return std::string(buf);
}

} // namespace rackmcp
