#include <doctest.h>
#include <set>
#include <string>
#include "core/crypto.hpp"

using namespace rackmcp;

TEST_CASE("sha256 NIST vectors") {
    CHECK(sha256Hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    CHECK(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    // One million 'a's exercises multi-block streaming.
    std::string million(1000000, 'a');
    CHECK(sha256Hex(million) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST_CASE("sha256 streaming equals one-shot") {
    Sha256 h;
    std::string msg = "The quick brown fox jumps over the lazy dog";
    for (size_t i = 0; i < msg.size(); i += 7)
        h.update(msg.data() + i, std::min<size_t>(7, msg.size() - i));
    uint8_t d[32];
    h.finish(d);
    CHECK(toHex(d, 32) == sha256Hex(msg));
    CHECK(sha256Hex(msg) == "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
}

TEST_CASE("hmac-sha256 RFC 4231 vectors") {
    // Test case 1
    std::string key1(20, '\x0b');
    CHECK(hmacSha256Hex(key1, "Hi There") ==
          "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    // Test case 2
    CHECK(hmacSha256Hex("Jefe", "what do ya want for nothing?") ==
          "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    // Test case 3: 20x 0xaa key, 50x 0xdd data
    std::string key3(20, '\xaa');
    std::string data3(50, '\xdd');
    CHECK(hmacSha256Hex(key3, data3) ==
          "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe");
    // Test case 6: 131-byte key (forces key hashing)
    std::string key6(131, '\xaa');
    CHECK(hmacSha256Hex(key6, "Test Using Larger Than Block-Size Key - Hash Key First") ==
          "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
}

TEST_CASE("constant-time equality") {
    CHECK(constantTimeEqual("", ""));
    CHECK(constantTimeEqual("abc", "abc"));
    CHECK_FALSE(constantTimeEqual("abc", "abd"));
    CHECK_FALSE(constantTimeEqual("abc", "ab"));
    std::string a(64, 'x'), b(64, 'x');
    CHECK(constantTimeEqual(a, b));
    b[63] = 'y';
    CHECK_FALSE(constantTimeEqual(a, b));
}

TEST_CASE("hex round trip and strictness") {
    std::string out;
    REQUIRE(fromHex("00ff10ab", out));
    CHECK(out.size() == 4);
    CHECK((uint8_t) out[1] == 0xff);
    CHECK(toHex((const uint8_t*) out.data(), out.size()) == "00ff10ab");
    CHECK_FALSE(fromHex("0", out));
    CHECK_FALSE(fromHex("zz", out));
    CHECK(fromHex("ABCDEF01", out));
}

TEST_CASE("randomBytes produces distinct high-entropy output") {
    std::set<std::string> seen;
    for (int i = 0; i < 16; i++) {
        std::string h = randomHex(32);
        REQUIRE(h.size() == 64);
        seen.insert(h);
    }
    CHECK(seen.size() == 16);
}
