# RackMCP plugin. Build with the pinned Rack SDK:
#   ./scripts/fetch-rack-sdk.sh && make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK
RACK_DIR ?= ../../vendor/Rack-SDK

FLAGS += -Isrc
# The Rack SDK always supplies jansson. tests/cpp can build core/ without it,
# so the sources guard on this macro; the plugin must therefore set it.
FLAGS += -DRACKMCP_HAVE_JANSSON=1
CFLAGS +=
CXXFLAGS +=
LDFLAGS +=

SOURCES += $(wildcard src/*.cpp)
SOURCES += $(wildcard src/core/*.cpp)
SOURCES += $(wildcard src/rackside/*.cpp)

DISTRIBUTABLES += res
DISTRIBUTABLES += LICENSE

# arch.mk is safe to include early (plugin.mk includes it again). On Windows
# the bridge needs Winsock2 (tcp.cpp) and CNG (crypto.cpp: BCryptGenRandom);
# MinGW does not honour #pragma comment(lib), so link them explicitly.
include $(RACK_DIR)/arch.mk
ifdef ARCH_WIN
	LDFLAGS += -lws2_32 -lbcrypt
endif

include $(RACK_DIR)/plugin.mk
