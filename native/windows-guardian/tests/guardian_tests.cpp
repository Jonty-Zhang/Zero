#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cwchar>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {
std::wstring ModulePath() {
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                           static_cast<DWORD>(buffer.size()));
  return length == 0 || length >= buffer.size()
             ? std::wstring()
             : std::wstring(buffer.data(), length);
}

std::wstring Quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') {
      ++slashes;
    } else if (c == L'\"') {
      result.append(slashes * 2 + 1, L'\\');
      result.push_back(c);
      slashes = 0;
    } else {
      result.append(slashes, L'\\');
      result.push_back(c);
      slashes = 0;
    }
  }
  result.append(slashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

bool Start(const std::wstring& command_line, PROCESS_INFORMATION* process) {
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  return CreateProcessW(nullptr, mutable_command.data(), nullptr, nullptr, FALSE,
                        0, nullptr, nullptr, &startup, process) != FALSE;
}

bool WaitForFile(const std::filesystem::path& path, DWORD timeout_ms) {
  const ULONGLONG end = GetTickCount64() + timeout_ms;
  while (GetTickCount64() < end) {
    if (std::filesystem::exists(path)) return true;
    Sleep(20);
  }
  return std::filesystem::exists(path);
}

bool WaitForExit(HANDLE process, DWORD timeout_ms) {
  return WaitForSingleObject(process, timeout_ms) == WAIT_OBJECT_0;
}

int Fail(const char* message) {
  std::cerr << "guardian test failed: " << message << "\n";
  return 1;
}

std::wstring TempPath(const wchar_t* suffix) {
  wchar_t directory[MAX_PATH]{};
  if (GetTempPathW(MAX_PATH, directory) == 0) return {};
  GUID id{};
  if (CoCreateGuid(&id) != S_OK) return {};
  wchar_t guid[40]{};
  if (StringFromGUID2(id, guid, 40) == 0) return {};
  std::wstring result(directory);
  result += L"zero-guardian-";
  result += guid;
  result += suffix;
  return result;
}

int RunNormalExit(const std::wstring& guardian, const std::wstring& test_exe) {
  const std::wstring command = Quote(guardian) + L" --lock-id normal-exit -- " +
                               Quote(test_exe) + L" --helper-exit 23";
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return Fail("could not start normal-exit guardian");
  const bool exited = WaitForExit(process.hProcess, 15000);
  DWORD exit_code = 0;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (!exited || exit_code != 23) return Fail("normal child exit code was not preserved");
  return 0;
}

int RunForcedTreeCleanup(const std::wstring& guardian,
                         const std::wstring& test_exe) {
  const std::wstring report_name = TempPath(L".txt");
  if (report_name.empty()) return Fail("could not allocate a temporary report name");
  const std::wstring command = Quote(guardian) + L" --lock-id forced-tree -- " +
                               Quote(test_exe) + L" --helper-tree " +
                               Quote(report_name);
  PROCESS_INFORMATION guardian_process{};
  if (!Start(command, &guardian_process)) return Fail("could not start tree guardian");

  const std::filesystem::path report(report_name);
  if (!WaitForFile(report, 15000)) {
    TerminateProcess(guardian_process.hProcess, 1);
    WaitForSingleObject(guardian_process.hProcess, INFINITE);
    CloseHandle(guardian_process.hThread);
    CloseHandle(guardian_process.hProcess);
    return Fail("tree helper did not publish process IDs");
  }

  DWORD child_pid = 0;
  DWORD grandchild_pid = 0;
  {
    std::ifstream input(report);
    input >> child_pid >> grandchild_pid;
  }
  HANDLE child = OpenProcess(SYNCHRONIZE, FALSE, child_pid);
  HANDLE grandchild = OpenProcess(SYNCHRONIZE, FALSE, grandchild_pid);
  if (child == nullptr || grandchild == nullptr) {
    TerminateProcess(guardian_process.hProcess, 1);
    WaitForSingleObject(guardian_process.hProcess, INFINITE);
    if (child) CloseHandle(child);
    if (grandchild) CloseHandle(grandchild);
    CloseHandle(guardian_process.hThread);
    CloseHandle(guardian_process.hProcess);
    DeleteFileW(report_name.c_str());
    return Fail("could not observe child and grandchild before termination");
  }

  TerminateProcess(guardian_process.hProcess, 99);
  WaitForSingleObject(guardian_process.hProcess, INFINITE);
  const bool tree_stopped = WaitForExit(child, 15000) && WaitForExit(grandchild, 15000);
  CloseHandle(child);
  CloseHandle(grandchild);
  CloseHandle(guardian_process.hThread);
  CloseHandle(guardian_process.hProcess);
  DeleteFileW(report_name.c_str());
  if (!tree_stopped) return Fail("Job close left a descendant running");
  return 0;
}

int RunDuplicateLock(const std::wstring& guardian, const std::wstring& test_exe) {
  const std::wstring report_name = TempPath(L".lock");
  if (report_name.empty()) return Fail("could not allocate lock test report name");
  const std::wstring first_command = Quote(guardian) + L" --lock-id duplicate -- " +
                                    Quote(test_exe) + L" --helper-report-wait " +
                                    Quote(report_name);
  PROCESS_INFORMATION first{};
  if (!Start(first_command, &first)) return Fail("could not start first lock guardian");
  const std::filesystem::path report(report_name);
  if (!WaitForFile(report, 15000)) {
    TerminateProcess(first.hProcess, 1);
    WaitForSingleObject(first.hProcess, INFINITE);
    CloseHandle(first.hThread);
    CloseHandle(first.hProcess);
    return Fail("first lock child did not start");
  }

  const std::wstring second_command = Quote(guardian) + L" --lock-id duplicate -- " +
                                     Quote(test_exe) + L" --helper-exit 0";
  PROCESS_INFORMATION second{};
  if (!Start(second_command, &second)) {
    TerminateProcess(first.hProcess, 1);
    WaitForSingleObject(first.hProcess, INFINITE);
    CloseHandle(first.hThread);
    CloseHandle(first.hProcess);
    DeleteFileW(report_name.c_str());
    return Fail("could not start duplicate guardian");
  }
  const bool exited = WaitForExit(second.hProcess, 10000);
  DWORD exit_code = 0;
  if (exited) GetExitCodeProcess(second.hProcess, &exit_code);
  CloseHandle(second.hThread);
  CloseHandle(second.hProcess);

  TerminateProcess(first.hProcess, 1);
  WaitForSingleObject(first.hProcess, INFINITE);
  CloseHandle(first.hThread);
  CloseHandle(first.hProcess);
  DeleteFileW(report_name.c_str());
  if (!exited || exit_code == 0) return Fail("duplicate lock was not rejected");
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 3 && wcscmp(argv[1], L"--helper-exit") == 0) {
    return _wtoi(argv[2]);
  }
  if (argc >= 3 && wcscmp(argv[1], L"--helper-report-wait") == 0) {
    std::ofstream output{std::filesystem::path(argv[2])};
    output << GetCurrentProcessId() << "\n";
    output.close();
    Sleep(60000);
    return 0;
  }
  if (argc >= 3 && wcscmp(argv[1], L"--helper-tree") == 0) {
    const std::wstring self = ModulePath();
    const std::wstring command = Quote(self) + L" --helper-leaf";
    PROCESS_INFORMATION leaf{};
    if (!Start(command, &leaf)) return 81;
    CloseHandle(leaf.hThread);
    CloseHandle(leaf.hProcess);
    std::ofstream output{std::filesystem::path(argv[2])};
    output << GetCurrentProcessId() << " " << leaf.dwProcessId << "\n";
    output.close();
    Sleep(60000);
    return 0;
  }
  if (argc >= 2 && wcscmp(argv[1], L"--helper-leaf") == 0) {
    Sleep(60000);
    return 0;
  }
  if (argc != 2) return Fail("expected guardian executable path");

  const std::wstring guardian(argv[1]);
  const std::wstring test_exe = ModulePath();
  if (test_exe.empty()) return Fail("could not resolve test executable path");
  if (RunNormalExit(guardian, test_exe) != 0) return 1;
  if (RunDuplicateLock(guardian, test_exe) != 0) return 1;
  if (RunForcedTreeCleanup(guardian, test_exe) != 0) return 1;
  std::cout << "Windows guardian tests passed\n";
  return 0;
}
