#include <doctest.h>
#include <cstdlib>
#include <string>
#include <vector>
#include "core/activitylog.hpp"

using namespace rackmcp;

TEST_CASE("a ring evicts the oldest entry, never the newest") {
    // The failure this guards against is silent: a ring that drops the newest
    // entry looks correct until the log is busy, and then quietly stops
    // reporting what just happened, which is the only part anyone reads.
    BoundedRing<ActivityEntry> ring(3);
    for (int i = 1; i <= 5; i++) {
        ActivityEntry e;
        e.method = "m" + std::to_string(i);
        ring.push(e);
    }
    std::vector<ActivityEntry> all = ring.snapshot();
    REQUIRE(all.size() == 3);
    CHECK(all[0].method == "m3");
    CHECK(all[2].method == "m5");
    CHECK(ring.evicted() == 2);
}

TEST_CASE("sequence numbers are monotonic and survive eviction") {
    BoundedRing<ActivityEntry> ring(2);
    ActivityEntry e;
    CHECK(ring.push(e) == 1);
    CHECK(ring.push(e) == 2);
    CHECK(ring.push(e) == 3);
    CHECK(ring.lastSeq() == 3);
    // The first entry is gone but its number was never reused.
    CHECK(ring.snapshot()[0].seq == 2);
}

TEST_CASE("since() returns only what the caller has not seen") {
    BoundedRing<ChatEntry> ring(8);
    for (int i = 0; i < 4; i++) {
        ChatEntry c;
        c.text = "n" + std::to_string(i);
        ring.push(c);
    }
    CHECK(ring.since(0).size() == 4);
    CHECK(ring.since(2).size() == 2);
    CHECK(ring.since(2)[0].text == "n2");
    CHECK(ring.since(4).empty());
    CHECK(ring.since(99).empty());
}

TEST_CASE("clear() does not reset the sequence, so a stale cursor stays stale") {
    // A server holding cursor=3 across a clear must not be handed a fresh
    // entry numbered 1 and told it is old news.
    BoundedRing<ChatEntry> ring(4);
    ChatEntry c;
    ring.push(c);
    ring.push(c);
    ring.push(c);
    ring.clear();
    CHECK(ring.size() == 0);
    const unsigned long long next = ring.push(c);
    CHECK(next == 4);
    CHECK(ring.since(3).size() == 1);
}

TEST_CASE("delivery marking is idempotent and reports only real changes") {
    BoundedRing<ChatEntry> ring(8);
    ChatEntry c;
    ring.push(c);
    ring.push(c);
    ring.push(c);
    CHECK(ring.markDelivered(2) == 2);
    CHECK(ring.markDelivered(2) == 0); // already marked
    CHECK(ring.markDelivered(3) == 1);
    for (const ChatEntry& e : ring.snapshot())
        CHECK(e.delivered);
}

TEST_CASE("an entry carries its error code and reports ok() accordingly") {
    ActivityEntry ok;
    ok.method = "patch.snapshot";
    CHECK(ok.ok());
    ActivityEntry failed;
    failed.method = "txn.commit";
    failed.errorCode = "WRITER_LEASE_REQUIRED";
    CHECK_FALSE(failed.ok());
}

TEST_CASE("overlong chat text is cut without splitting a UTF-8 sequence") {
    // jansson refuses to encode invalid UTF-8, so a naive substr would turn one
    // overlong note into a frame that cannot be built at all.
    const std::string emoji = "\xF0\x9F\x8E\x9B"; // U+1F39B, four bytes
    // The single ASCII byte matters: without it the limit divides evenly by
    // four, a naive substr lands on a sequence boundary by luck, and this test
    // passes against the bug it exists to catch.
    std::string text = "x";
    while (text.size() < CHAT_MAX_TEXT_BYTES + 8)
        text += emoji;
    REQUIRE((CHAT_MAX_TEXT_BYTES - 1) % 4 != 0);

    const std::string clamped = clampChatText(text);
    CHECK(clamped.size() <= CHAT_MAX_TEXT_BYTES);
    CHECK(clamped.size() < CHAT_MAX_TEXT_BYTES); // had to walk back off a partial
    CHECK((clamped.size() - 1) % 4 == 0);        // whole sequences after the "x"

    // Every byte is either an ASCII byte or part of a complete sequence.
    size_t i = 0;
    while (i < clamped.size()) {
        const unsigned char b = static_cast<unsigned char>(clamped[i]);
        size_t len = 1;
        if ((b & 0xE0) == 0xC0) len = 2;
        else if ((b & 0xF0) == 0xE0) len = 3;
        else if ((b & 0xF8) == 0xF0) len = 4;
        REQUIRE(i + len <= clamped.size());
        i += len;
    }
    CHECK(i == clamped.size());
}

TEST_CASE("text within the limit is returned untouched") {
    CHECK(clampChatText("make the filter darker") == "make the filter darker");
    CHECK(clampChatText("").empty());
    const std::string exact(CHAT_MAX_TEXT_BYTES, 'x');
    CHECK(clampChatText(exact) == exact);
}

TEST_CASE("the clock is a well-formed hh:mm:ss") {
    const std::string now = clockNow();
    REQUIRE(now.size() == 8);
    CHECK(now[2] == ':');
    CHECK(now[5] == ':');
    for (size_t i = 0; i < now.size(); i++)
        if (i != 2 && i != 5)
            CHECK(now[i] >= '0');
}

// ---------------------------------------------------------------------------
// chat.poll payload
//
// A note can only be created by typing into the Rack panel, and Rack draws its
// UI in OpenGL with no accessibility tree, so no script can produce one — the
// captured fixture is necessarily the empty case. These are the only tests that
// ever see a non-empty poll. They matter more than they look: json_pack returns
// NULL on a bad format string, and a NULL payload becomes a well-formed
// response frame with no result at all, which nothing else here would notice.

#if RACKMCP_HAVE_JANSSON

static ChatEntry note(unsigned long long seq, const std::string& text, const std::string& clock) {
    ChatEntry e;
    e.seq = seq;
    e.fromUser = true;
    e.text = text;
    e.clock = clock;
    return e;
}

TEST_CASE("a poll carrying notes has the shape the schema declares") {
    std::vector<ChatEntry> notes;
    notes.push_back(note(7, "make the filter darker", "14:03:11"));
    notes.push_back(note(8, "actually, brighter", "14:03:29"));

    json_t* payload = buildChatPollPayload(notes, 8, 2);
    REQUIRE(payload != NULL);
    CHECK(json_object_size(payload) == 3);

    json_t* arr = json_object_get(payload, "notes");
    REQUIRE(json_is_array(arr));
    REQUIRE(json_array_size(arr) == 2);
    CHECK(json_integer_value(json_object_get(payload, "lastSeq")) == 8);
    CHECK(json_integer_value(json_object_get(payload, "dropped")) == 2);

    json_t* first = json_array_get(arr, 0);
    // Exactly three keys: an extra one fails the strict() parse on the far side.
    CHECK(json_object_size(first) == 3);
    CHECK(json_integer_value(json_object_get(first, "seq")) == 7);
    CHECK(std::string(json_string_value(json_object_get(first, "text"))) ==
          "make the filter darker");
    CHECK(std::string(json_string_value(json_object_get(first, "clock"))) == "14:03:11");
    CHECK(json_integer_value(json_object_get(json_array_get(arr, 1), "seq")) == 8);

    // The array must be owned by the payload alone, or the poll leaks a note
    // list per call for as long as Rack is open.
    CHECK(arr->refcount == 1);
    json_decref(payload);
}

TEST_CASE("note text survives the characters a person actually types") {
    // Typed text is the only attacker-adjacent string the plugin ever emits, and
    // it reaches the server as JSON. Round-trip through the encoder rather than
    // trusting the in-memory object, so a quoting bug cannot hide.
    std::vector<ChatEntry> notes;
    notes.push_back(note(1, "say \"hello\"\\n\tnow \xC3\xA9\xC3\xA8 \xE2\x86\x92", "00:00:01"));

    json_t* payload = buildChatPollPayload(notes, 1, 0);
    REQUIRE(payload != NULL);
    char* dumped = json_dumps(payload, JSON_COMPACT);
    REQUIRE(dumped != NULL);

    json_error_t err;
    json_t* reparsed = json_loads(dumped, 0, &err);
    REQUIRE(reparsed != NULL);
    json_t* text = json_object_get(json_array_get(json_object_get(reparsed, "notes"), 0), "text");
    CHECK(std::string(json_string_value(text)) ==
          "say \"hello\"\\n\tnow \xC3\xA9\xC3\xA8 \xE2\x86\x92");

    free(dumped);
    json_decref(reparsed);
    json_decref(payload);
}

TEST_CASE("an empty poll matches the fixture captured from a live Rack") {
    // tests/fixtures/bridge/chat.poll.json came off a real bridge and is
    // strict-parsed by packages/schemas. Comparing against the bytes rather
    // than a hand-written copy is what makes this a drift check: if the
    // producer gains, loses or renames a key, the two stop agreeing here
    // without anyone having to remember to update a second expectation.
    const std::string path = std::string(RACKMCP_TEST_FIXTURES) + "/bridge/chat.poll.json";
    json_error_t err;
    json_t* fixture = json_load_file(path.c_str(), 0, &err);
    REQUIRE_MESSAGE(fixture != NULL, "could not read ", path, ": ", err.text);

    json_t* produced = buildChatPollPayload(std::vector<ChatEntry>(), 0, 0);
    REQUIRE(produced != NULL);
    CHECK(json_equal(fixture, produced));

    json_decref(fixture);
    json_decref(produced);
}

#endif  // RACKMCP_HAVE_JANSSON
