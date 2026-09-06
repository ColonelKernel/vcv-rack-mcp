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

#if RACKMCP_HAVE_JANSSON
json_t* buildChatPollPayload(const std::vector<ChatEntry>& notes, unsigned long long lastSeq,
                             unsigned long long dropped) {
    json_t* arr = json_array();
    for (size_t i = 0; i < notes.size(); i++) {
        json_t* n = json_pack("{s:I, s:s, s:s}",
                              "seq", (json_int_t) notes[i].seq,
                              "text", notes[i].text.c_str(),
                              "clock", notes[i].clock.c_str());
        // A note that cannot be packed is dropped rather than poisoning the
        // whole poll: one bad entry must not cost the client every other note.
        if (n)
            json_array_append_new(arr, n);
    }
    json_t* payload = json_pack("{s:o, s:I, s:I}",
                                "notes", arr,
                                "lastSeq", (json_int_t) lastSeq,
                                "dropped", (json_int_t) dropped);
    if (!payload)
        json_decref(arr);
    return payload;
}
#endif

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
