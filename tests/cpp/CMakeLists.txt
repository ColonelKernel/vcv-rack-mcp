cmake_minimum_required(VERSION 3.20)
project(rackmcp_cpp_tests CXX)

# The plugin itself is built with the Rack SDK's Makefile system (C++11).
# This harness builds the Rack-free `core` sources and the generated protocol
# header for unit testing and fuzzing, at the same language level.
set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

# Warning flags per compiler family: MSVC rejects GCC-style -W options
# ("invalid numeric argument '/Wextra'").
if(MSVC)
  add_compile_options(/W4)
else()
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

set(RACKMCP_PLUGIN_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../../plugins/RackMCP/src)
set(RACKMCP_THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../../third_party)

# jansson is required by the canonical-JSON module. The plugin gets it from
# the Rack SDK; the host-side tests use a system jansson when available.
find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
  pkg_check_modules(JANSSON IMPORTED_TARGET jansson)
endif()

set(RACKMCP_CORE_SOURCES
  ${RACKMCP_PLUGIN_SRC}/core/framing.cpp
  ${RACKMCP_PLUGIN_SRC}/core/crypto.cpp
  ${RACKMCP_PLUGIN_SRC}/core/uuid.cpp
  ${RACKMCP_PLUGIN_SRC}/core/tcp.cpp
  ${RACKMCP_PLUGIN_SRC}/core/lease.cpp
  ${RACKMCP_PLUGIN_SRC}/core/secret.cpp
)
if(JANSSON_FOUND)
  list(APPEND RACKMCP_CORE_SOURCES
    ${RACKMCP_PLUGIN_SRC}/core/canonical.cpp
    ${RACKMCP_PLUGIN_SRC}/core/frames.cpp
    ${RACKMCP_PLUGIN_SRC}/core/manifest.cpp
    ${RACKMCP_PLUGIN_SRC}/core/service.cpp
  )
endif()

add_library(rackmcp_core STATIC ${RACKMCP_CORE_SOURCES})
target_include_directories(rackmcp_core PUBLIC ${RACKMCP_PLUGIN_SRC})
if(WIN32)
  # tcp.cpp uses Winsock2 and crypto.cpp uses BCryptGenRandom on Windows
  # (MSVC honours #pragma comment(lib); MinGW does not, so link explicitly).
  target_link_libraries(rackmcp_core PUBLIC ws2_32 bcrypt)
endif()
if(JANSSON_FOUND)
  target_link_libraries(rackmcp_core PUBLIC PkgConfig::JANSSON)
  target_compile_definitions(rackmcp_core PUBLIC RACKMCP_HAVE_JANSSON=1)
else()
  message(WARNING "jansson not found; canonical-JSON module and its tests are skipped")
endif()

enable_testing()

file(GLOB RACKMCP_TEST_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/*.test.cpp)
if(NOT JANSSON_FOUND)
  list(REMOVE_ITEM RACKMCP_TEST_SOURCES
    ${CMAKE_CURRENT_SOURCE_DIR}/canonical.test.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/service.test.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/secret_manifest.test.cpp
  )
endif()
add_executable(rackmcp_tests main.cpp ${RACKMCP_TEST_SOURCES})
target_include_directories(rackmcp_tests PRIVATE ${RACKMCP_THIRD_PARTY}/doctest)
target_link_libraries(rackmcp_tests PRIVATE rackmcp_core)
add_test(NAME rackmcp_tests COMMAND rackmcp_tests)

# Optional libFuzzer target for the frame decoder (clang only).
option(RACKMCP_BUILD_FUZZERS "Build libFuzzer targets" OFF)
if(RACKMCP_BUILD_FUZZERS)
  add_executable(fuzz_frame_decoder ${CMAKE_CURRENT_SOURCE_DIR}/fuzz/fuzz_frame_decoder.cpp)
  target_include_directories(fuzz_frame_decoder PRIVATE ${RACKMCP_PLUGIN_SRC})
  target_link_libraries(fuzz_frame_decoder PRIVATE rackmcp_core)
  target_compile_options(fuzz_frame_decoder PRIVATE -fsanitize=fuzzer,address)
  target_link_options(fuzz_frame_decoder PRIVATE -fsanitize=fuzzer,address)
endif()
