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

add_compile_options(-Wall -Wextra -Wpedantic)

set(RACKMCP_PLUGIN_SRC ${CMAKE_CURRENT_SOURCE_DIR}/../../plugins/RackMCP/src)
set(RACKMCP_THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../../third_party)

file(GLOB RACKMCP_CORE_SOURCES ${RACKMCP_PLUGIN_SRC}/core/*.cpp)

add_library(rackmcp_core STATIC ${RACKMCP_CORE_SOURCES})
target_include_directories(rackmcp_core PUBLIC ${RACKMCP_PLUGIN_SRC})

enable_testing()

file(GLOB RACKMCP_TEST_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/*.test.cpp)
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
