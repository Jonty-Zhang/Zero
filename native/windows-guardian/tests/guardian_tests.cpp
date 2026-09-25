#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <sddl.h>

#include <cwchar>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {
bool IsGeneration(const std::wstring& value) {
  if (value.size() != 32) return false;
  for (wchar_t c : value) {
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return false;
  }
  return true;
}

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

void SignalFile(const std::wstring& path) {
  std::ofstream signal(path);
  signal << "release\n";
}

int Fail(const char* message) {
  std::cerr << "guardian test failed: " << message << "\n";
  return 1;
}

DWORD InvokeVerifier(const std::wstring& guardian, const std::wstring& lock_id,
                     DWORD process_id) {
  const std::wstring command = Quote(guardian) + L" --verify-member --lock-id " +
      Quote(lock_id) + L" --pid " + std::to_wstring(process_id);
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return MAXDWORD;
  const bool exited = WaitForExit(process.hProcess, 5000);
  DWORD exit_code = MAXDWORD;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  else TerminateProcess(process.hProcess, 1);
  WaitForSingleObject(process.hProcess, INFINITE);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return exit_code;
}

DWORD InvokeStartupVerifier(const std::wstring& guardian, const std::wstring& lock_id,
                            const std::wstring& generation, DWORD process_id) {
  const std::wstring command = Quote(guardian) + L" --verify-startup --lock-id " +
      Quote(lock_id) + L" --generation " + Quote(generation) + L" --pid " +
      std::to_wstring(process_id);
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return MAXDWORD;
  const bool exited = WaitForExit(process.hProcess, 5000);
  DWORD exit_code = MAXDWORD;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  else TerminateProcess(process.hProcess, 1);
  WaitForSingleObject(process.hProcess, INFINITE);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return exit_code;
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

std::wstring CurrentUserSidString() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return {};
  DWORD bytes = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &bytes);
  if (bytes == 0) {
    CloseHandle(token);
    return {};
  }
  std::vector<unsigned char> buffer(bytes);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), bytes, &bytes)) {
    CloseHandle(token);
    return {};
  }
  CloseHandle(token);
  auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) return {};
  std::wstring result(sid);
  LocalFree(sid);
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

int RunGenerationEnvironment(const std::wstring& guardian, const std::wstring& test_exe) {
  const std::wstring report_name = TempPath(L".generation.txt");
  if (report_name.empty()) return Fail("could not allocate generation report name");
  const std::wstring lock_id = L"generation-env";
  const std::wstring command = Quote(guardian) + L" --lock-id " + lock_id + L" -- " +
      Quote(test_exe) + L" --helper-report-generation " + Quote(report_name);
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return Fail("could not start generation guardian");
  const bool exited = WaitForExit(process.hProcess, 15000);
  DWORD exit_code = 1;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  std::string lock;
  std::string generation;
  std::string drained;
  if (std::filesystem::exists(report_name)) {
    std::ifstream input{std::filesystem::path(report_name)};
    input >> lock >> generation >> drained;
  }
  DeleteFileW(report_name.c_str());
  const bool valid_generation = generation.size() == 32 &&
      generation.find_first_not_of("0123456789abcdef") == std::string::npos;
  if (!exited || exit_code != 0 || lock != "generation-env" || !valid_generation || drained != "1") {
    return Fail("guardian child did not receive valid startup lineage assertions");
  }
  return 0;
}

int RunMemberVerification(const std::wstring& guardian,
                          const std::wstring& test_exe) {
  const std::wstring lock_id = L"member-check-" + std::to_wstring(GetCurrentProcessId());
  const std::wstring command = Quote(guardian) + L" --lock-id " + lock_id + L" -- " +
      Quote(test_exe) + L" --helper-verify-member " + Quote(guardian) + L" " +
      lock_id + L" " + std::to_wstring(GetCurrentProcessId());
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return Fail("could not start member-check guardian");
  const bool exited = WaitForExit(process.hProcess, 15000);
  DWORD exit_code = 1;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (!exited || exit_code != 0) return Fail("guardian member verification rejected a valid Job member or accepted a non-member");

  const std::wstring invalid_command = Quote(guardian) + L" --verify-member --lock-id";
  PROCESS_INFORMATION invalid{};
  if (!Start(invalid_command, &invalid)) return Fail("could not start invalid-argument verifier");
  const bool invalid_exited = WaitForExit(invalid.hProcess, 5000);
  DWORD invalid_code = 0;
  if (invalid_exited) GetExitCodeProcess(invalid.hProcess, &invalid_code);
  CloseHandle(invalid.hThread);
  CloseHandle(invalid.hProcess);
  if (!invalid_exited || invalid_code == 0) return Fail("member verifier accepted invalid arguments");
  return 0;
}

int RunStartupAttestation(const std::wstring& guardian,
                          const std::wstring& test_exe) {
  const std::wstring report_name = TempPath(L".startup.txt");
  if (report_name.empty()) return Fail("could not allocate startup report name");
  const std::wstring lock_id = L"startup-proof-" + std::to_wstring(GetCurrentProcessId());
  const std::wstring command = Quote(guardian) + L" --lock-id " + lock_id + L" -- " +
      Quote(test_exe) + L" --helper-verify-startup " + Quote(guardian) + L" " +
      lock_id + L" " + Quote(report_name);
  PROCESS_INFORMATION process{};
  if (!Start(command, &process)) return Fail("could not start startup-proof guardian");
  const bool exited = WaitForExit(process.hProcess, 15000);
  DWORD exit_code = 1;
  if (exited) GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  DWORD child_pid = 0;
  std::wstring generation;
  if (std::filesystem::exists(report_name)) {
    std::wifstream input{std::filesystem::path(report_name)};
    input >> generation >> child_pid;
  }
  DeleteFileW(report_name.c_str());
  if (!exited || exit_code != 0 || !IsGeneration(generation) || child_pid == 0) {
    return Fail("direct child startup attestation did not pass its scenarios");
  }
  if (InvokeStartupVerifier(guardian, lock_id, generation, child_pid) == 0) {
    return Fail("startup verifier accepted a child after its guardian exited");
  }

  // A same-user mapping that predates this guardian must never be adopted as proof.
  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return Fail("could not resolve SID for spoof mapping test");
  const std::wstring spoof_lock = L"startup-spoof-" + std::to_wstring(GetCurrentProcessId());
  const std::wstring mapping_name = L"Local\\ZeroGuardianStartup_" + sid + L"_" + spoof_lock;
  HANDLE spoof = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                   0, 4096, mapping_name.c_str());
  if (spoof == nullptr || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (spoof) CloseHandle(spoof);
    return Fail("could not create preexisting spoof mapping");
  }
  const std::wstring spoof_report = TempPath(L".spoof.txt");
  const std::wstring spoof_command = Quote(guardian) + L" --lock-id " + spoof_lock + L" -- " +
      Quote(test_exe) + L" --helper-report-generation " + Quote(spoof_report);
  PROCESS_INFORMATION spoof_process{};
  const bool spoof_started = Start(spoof_command, &spoof_process);
  DWORD spoof_exit = 0;
  const bool spoof_exited = spoof_started && WaitForExit(spoof_process.hProcess, 10000);
  if (spoof_exited) GetExitCodeProcess(spoof_process.hProcess, &spoof_exit);
  if (spoof_started) {
    if (!spoof_exited) TerminateProcess(spoof_process.hProcess, 1);
    WaitForSingleObject(spoof_process.hProcess, INFINITE);
    CloseHandle(spoof_process.hThread);
    CloseHandle(spoof_process.hProcess);
  }
  CloseHandle(spoof);
  DeleteFileW(spoof_report.c_str());
  if (!spoof_exited || spoof_exit == 0) return Fail("guardian adopted a preexisting spoof mapping");
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

int RunSuccessorWaitsForPreviousTree(const std::wstring& guardian,
                                     const std::wstring& test_exe) {
  const std::wstring report_name = TempPath(L".held-tree.txt");
  const std::wstring release_name = TempPath(L".release");
  const std::wstring launch_name = TempPath(L".successor-launched");
  if (report_name.empty() || release_name.empty() || launch_name.empty()) {
    return Fail("could not allocate successor test paths");
  }
  const std::wstring lock_id = L"successor-wait-" + std::to_wstring(GetCurrentProcessId());
  const std::wstring first_command = Quote(guardian) + L" --lock-id " + lock_id + L" -- " +
      Quote(test_exe) + L" --helper-held-tree " + Quote(report_name) + L" " +
      Quote(release_name) + L" " + lock_id;
  PROCESS_INFORMATION first{};
  if (!Start(first_command, &first)) return Fail("could not start held-tree guardian");

  const std::filesystem::path report(report_name);
  if (!WaitForFile(report, 15000)) {
    SignalFile(release_name);
    TerminateProcess(first.hProcess, 1);
    WaitForSingleObject(first.hProcess, INFINITE);
    CloseHandle(first.hThread);
    CloseHandle(first.hProcess);
    return Fail("held-tree helper did not publish process IDs");
  }
  DWORD child_pid = 0;
  DWORD grandchild_pid = 0;
  {
    std::ifstream input(report_name);
    input >> child_pid >> grandchild_pid;
  }
  HANDLE child = OpenProcess(SYNCHRONIZE, FALSE, child_pid);
  HANDLE grandchild = OpenProcess(SYNCHRONIZE, FALSE, grandchild_pid);
  if (child == nullptr || grandchild == nullptr) {
    SignalFile(release_name);
    TerminateProcess(first.hProcess, 1);
    WaitForSingleObject(first.hProcess, INFINITE);
    if (child) CloseHandle(child);
    if (grandchild) CloseHandle(grandchild);
    CloseHandle(first.hThread);
    CloseHandle(first.hProcess);
    return Fail("could not observe held-tree processes");
  }

  TerminateProcess(first.hProcess, 99);
  WaitForSingleObject(first.hProcess, INFINITE);
  CloseHandle(first.hThread);
  CloseHandle(first.hProcess);
  if (WaitForSingleObject(child, 0) != WAIT_TIMEOUT ||
      WaitForSingleObject(grandchild, 0) != WAIT_TIMEOUT) {
    SignalFile(release_name);
    WaitForExit(child, 15000);
    WaitForExit(grandchild, 15000);
    CloseHandle(child);
    CloseHandle(grandchild);
    return Fail("held Job did not preserve processes for successor wait test");
  }

  const std::wstring successor_command = Quote(guardian) + L" --lock-id " + lock_id + L" -- " +
      Quote(test_exe) + L" --helper-report-generation " + Quote(launch_name);
  PROCESS_INFORMATION successor{};
  if (!Start(successor_command, &successor)) {
    SignalFile(release_name);
    WaitForExit(child, 15000);
    WaitForExit(grandchild, 15000);
    CloseHandle(child);
    CloseHandle(grandchild);
    return Fail("could not start successor guardian");
  }
  Sleep(750);
  const bool launched_early = std::filesystem::exists(launch_name);
  const bool successor_exited_early = WaitForSingleObject(successor.hProcess, 0) == WAIT_OBJECT_0;
  if (launched_early || successor_exited_early) {
    TerminateProcess(successor.hProcess, 1);
    WaitForSingleObject(successor.hProcess, INFINITE);
    SignalFile(release_name);
    WaitForExit(child, 15000);
    WaitForExit(grandchild, 15000);
    CloseHandle(successor.hThread);
    CloseHandle(successor.hProcess);
    CloseHandle(child);
    CloseHandle(grandchild);
    return Fail("successor launched before prior Job descendants terminated");
  }

  SignalFile(release_name);
  const bool old_tree_stopped = WaitForExit(child, 15000) && WaitForExit(grandchild, 15000);
  const bool launched = WaitForFile(launch_name, 15000);
  const bool successor_exited = WaitForExit(successor.hProcess, 15000);
  DWORD successor_code = 1;
  if (successor_exited) GetExitCodeProcess(successor.hProcess, &successor_code);
  std::string observed_lock;
  std::string observed_generation;
  std::string observed_drained;
  if (std::filesystem::exists(launch_name)) {
    std::ifstream input{std::filesystem::path(launch_name)};
    input >> observed_lock >> observed_generation >> observed_drained;
  }
  CloseHandle(child);
  CloseHandle(grandchild);
  CloseHandle(successor.hThread);
  CloseHandle(successor.hProcess);
  DeleteFileW(report_name.c_str());
  DeleteFileW(release_name.c_str());
  DeleteFileW(launch_name.c_str());
  const bool valid_generation = observed_generation.size() == 32 &&
      observed_generation.find_first_not_of("0123456789abcdef") == std::string::npos;
  if (!old_tree_stopped || !launched || !successor_exited || successor_code != 0 ||
      observed_lock != std::string(lock_id.begin(), lock_id.end()) || !valid_generation || observed_drained != "1") {
    return Fail("successor did not launch after the prior tree became empty");
  }
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 3 && wcscmp(argv[1], L"--helper-exit") == 0) {
    return _wtoi(argv[2]);
  }
  if (argc >= 3 && wcscmp(argv[1], L"--helper-report-generation") == 0) {
    const wchar_t* lock = _wgetenv(L"ZERO_GUARDIAN_LOCK_ID");
    const wchar_t* generation = _wgetenv(L"ZERO_GUARDIAN_GENERATION");
    const wchar_t* drained = _wgetenv(L"ZERO_GUARDIAN_PREDECESSOR_DRAINED");
    if (!lock || !generation || !drained) return 86;
    std::wofstream output{std::filesystem::path(argv[2])};
    output << lock << L"\n" << generation << L"\n" << drained << L"\n";
    return output ? 0 : 87;
  }
  if (argc >= 5 && wcscmp(argv[1], L"--helper-verify-member") == 0) {
    const std::wstring guardian(argv[2]);
    const std::wstring lock_id(argv[3]);
    const DWORD outside_process = static_cast<DWORD>(_wtoi(argv[4]));
    if (InvokeVerifier(guardian, lock_id, GetCurrentProcessId()) != 0) return 88;
    if (InvokeVerifier(guardian, lock_id, outside_process) == 0) return 89;
    if (InvokeVerifier(guardian, lock_id + L"-wrong", GetCurrentProcessId()) == 0) return 90;
    if (InvokeVerifier(guardian, lock_id, MAXDWORD) == 0) return 91;
    return 0;
  }
  if (argc >= 5 && wcscmp(argv[1], L"--helper-verify-startup") == 0) {
    const std::wstring guardian(argv[2]);
    const std::wstring lock_id(argv[3]);
    const std::wstring report_name(argv[4]);
    const wchar_t* generation_value = _wgetenv(L"ZERO_GUARDIAN_GENERATION");
    if (generation_value == nullptr) return 92;
    const std::wstring generation(generation_value);
    if (!IsGeneration(generation) ||
        InvokeStartupVerifier(guardian, lock_id, generation, GetCurrentProcessId()) != 0) return 93;

    const std::wstring self = ModulePath();
    PROCESS_INFORMATION leaf{};
    if (!Start(Quote(self) + L" --helper-leaf", &leaf)) return 94;
    const DWORD leaf_pid = leaf.dwProcessId;
    CloseHandle(leaf.hThread);
    CloseHandle(leaf.hProcess);
    if (InvokeStartupVerifier(guardian, lock_id, generation, leaf_pid) == 0) return 95;
    std::wstring wrong_generation = generation;
    wrong_generation[0] = wrong_generation[0] == L'0' ? L'1' : L'0';
    if (InvokeStartupVerifier(guardian, lock_id, wrong_generation,
                              GetCurrentProcessId()) == 0) return 96;
    if (InvokeStartupVerifier(guardian, lock_id, generation, leaf_pid + 1000000) == 0) return 97;
    std::wofstream output{std::filesystem::path(report_name)};
    output << generation << L"\n" << GetCurrentProcessId() << L"\n";
    return output ? 0 : 98;
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
  if (argc >= 5 && wcscmp(argv[1], L"--helper-held-tree") == 0) {
    const std::wstring sid = CurrentUserSidString();
    if (sid.empty()) return 82;
    const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[4];
    // Hold an extra Job handle across guardian termination so the successor's
    // wait is observable; the release signal terminates this whole test tree.
    HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE,
                                job_name.c_str());
    if (job == nullptr) return 83;
    const std::wstring self = ModulePath();
    const std::wstring command = Quote(self) + L" --helper-leaf";
    PROCESS_INFORMATION leaf{};
    if (!Start(command, &leaf)) { CloseHandle(job); return 84; }
    CloseHandle(leaf.hThread);
    CloseHandle(leaf.hProcess);
    std::ofstream output{std::filesystem::path(argv[2])};
    output << GetCurrentProcessId() << " " << leaf.dwProcessId << "\n";
    output.close();
    while (!std::filesystem::exists(argv[3])) Sleep(20);
    TerminateJobObject(job, 0);
    CloseHandle(job);
    return 0;
  }
  if (argc >= 3 && wcscmp(argv[1], L"--helper-report-exit") == 0) {
    std::ofstream output{std::filesystem::path(argv[2])};
    output << GetCurrentProcessId() << "\n";
    return output ? 0 : 85;
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
  if (RunGenerationEnvironment(guardian, test_exe) != 0) return 1;
  if (RunMemberVerification(guardian, test_exe) != 0) return 1;
  if (RunStartupAttestation(guardian, test_exe) != 0) return 1;
  if (RunDuplicateLock(guardian, test_exe) != 0) return 1;
  if (RunForcedTreeCleanup(guardian, test_exe) != 0) return 1;
  if (RunSuccessorWaitsForPreviousTree(guardian, test_exe) != 0) return 1;
  std::cout << "Windows guardian tests passed\n";
  return 0;
}
