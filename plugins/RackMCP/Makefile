# RackMCP plugin. Build with the pinned Rack SDK:
#   ./scripts/fetch-rack-sdk.sh && make -C plugins/RackMCP RACK_DIR=../../vendor/Rack-SDK
RACK_DIR ?= ../../vendor/Rack-SDK

FLAGS += -Isrc
CFLAGS +=
CXXFLAGS +=
LDFLAGS +=

SOURCES += $(wildcard src/*.cpp)
SOURCES += $(wildcard src/core/*.cpp)
SOURCES += $(wildcard src/rackside/*.cpp)

DISTRIBUTABLES += res
DISTRIBUTABLES += LICENSE

include $(RACK_DIR)/plugin.mk
