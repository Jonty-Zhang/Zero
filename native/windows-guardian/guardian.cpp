#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <sddl.h>

#include <cwchar>
#include <string>
#include <vector>

namespace {
bool IsSafeLockId(const wchar_t* value);
bool ParseProcessId(const wchar_t* value, DWORD* process_id);
std::wstring CurrentUserSidString();

constexpr DWORD kFailure = 70;
constexpr DWORD kInvalidArgs = 64;
constexpr DWORD kNotJobMember = 65;
constexpr DWORD kVerifyFailure = 66;
constexpr DWORD kStartupVerifyFailure = 67;
constexpr DWORD kPollMilliseconds = 25;
constexpr DWORD kStartupRecordVersion = 1;

struct StartupRecord {
  DWORD version;
  wchar_t magic[8];
  wchar_t generation[33];
  DWORD guardian_pid;
  DWORD child_pid;
  FILETIME guardian_creation_time;
  FILETIME child_creation_time;
};

class StartupMapping {
 public:
  StartupMapping() = default;
  StartupMapping(const StartupMapping&) = delete;
  StartupMapping& operator=(const StartupMapping&) = delete;
  ~StartupMapping() { Reset(); }

  bool Create(const std::wstring& name) {
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.bInheritHandle = FALSE;
    SetLastError(ERROR_SUCCESS);
    handle_ = CreateFileMappingW(INVALID_HANDLE_VALUE, &attributes, PAGE_READWRITE,
                                 0, sizeof(StartupRecord), name.c_str());
    if (handle_ == nullptr) return false;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
      Reset();
      return false;
    }
    record_ = static_cast<StartupRecord*>(MapViewOfFile(
        handle_, FILE_MAP_WRITE, 0, 0, sizeof(StartupRecord)));
    if (record_ == nullptr) {
      Reset();
      return false;
    }
    ZeroMemory(record_, sizeof(*record_));
    return true;
  }

  void Publish(const std::wstring& generation, DWORD guardian_pid,
               DWORD child_pid, const FILETIME& guardian_creation_time,
               const FILETIME& child_creation_time) {
    record_->version = kStartupRecordVersion;
    const wchar_t magic[] = L"ZGSTRT1";
    wmemcpy(record_->magic, magic, _countof(magic));
    wmemcpy(record_->generation, generation.c_str(), generation.size() + 1);
    record_->guardian_pid = guardian_pid;
    record_->child_pid = child_pid;
    record_->guardian_creation_time = guardian_creation_time;
    record_->child_creation_time = child_creation_time;
    MemoryBarrier();
  }

 private:
  void Reset() {
    if (record_ != nullptr) {
      UnmapViewOfFile(record_);
      record_ = nullptr;
    }
    if (handle_ != nullptr) {
      CloseHandle(handle_);
      handle_ = nullptr;
    }
  }

  HANDLE handle_ = nullptr;
  StartupRecord* record_ = nullptr;
};

bool IsGeneration(const wchar_t* value) {
  if (value == nullptr) return false;
  for (size_t i = 0; i < 32; ++i) {
    const wchar_t c = value[i];
    if (c == L'\0') return false;
    if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') ||
          (c >= L'A' && c <= L'F'))) return false;
  }
  return value[32] == L'\0';
}

bool SameFileTime(const FILETIME& left, const FILETIME& right) {
  return left.dwLowDateTime == right.dwLowDateTime &&
         left.dwHighDateTime == right.dwHighDateTime;
}

bool ProcessMatches(DWORD process_id, const FILETIME& creation_time,
                    bool require_running) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                               FALSE, process_id);
  if (process == nullptr) return false;
  FILETIME actual_creation{}, exit_time{}, kernel_time{}, user_time{};
  const bool queried = GetProcessTimes(process, &actual_creation, &exit_time,
                                      &kernel_time, &user_time) != FALSE;
  const bool running = !require_running ||
      WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  CloseHandle(process);
  return queried && running && SameFileTime(creation_time, actual_creation);
}

int VerifyStartup(int argc, wchar_t** argv) {
  DWORD process_id = 0;
  if (argc != 8 || wcscmp(argv[2], L"--lock-id") != 0 || !IsSafeLockId(argv[3]) ||
      wcscmp(argv[4], L"--generation") != 0 || !IsGeneration(argv[5]) ||
      wcscmp(argv[6], L"--pid") != 0 || !ParseProcessId(argv[7], &process_id)) {
    return static_cast<int>(kInvalidArgs);
  }
  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return static_cast<int>(kStartupVerifyFailure);
  const std::wstring mapping_name = L"Local\\ZeroGuardianStartup_" + sid + L"_" + argv[3];
  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mapping_name.c_str());
  if (mapping == nullptr) return static_cast<int>(kStartupVerifyFailure);
  const StartupRecord* record = static_cast<const StartupRecord*>(MapViewOfFile(
      mapping, FILE_MAP_READ, 0, 0, sizeof(StartupRecord)));
  if (record == nullptr) {
    CloseHandle(mapping);
    return static_cast<int>(kStartupVerifyFailure);
  }
  MemoryBarrier();
  const StartupRecord snapshot = *record;
  const wchar_t expected_magic[] = L"ZGSTRT1";
  const bool valid_record = snapshot.version == kStartupRecordVersion &&
      wmemcmp(snapshot.magic, expected_magic, _countof(expected_magic)) == 0 &&
      IsGeneration(snapshot.generation) && wcscmp(snapshot.generation, argv[5]) == 0 &&
      snapshot.child_pid == process_id && snapshot.guardian_pid != 0;
  UnmapViewOfFile(record);
  CloseHandle(mapping);
  if (!valid_record || snapshot.guardian_pid == snapshot.child_pid ||
      !ProcessMatches(snapshot.guardian_pid, snapshot.guardian_creation_time, true) ||
      !ProcessMatches(snapshot.child_pid, snapshot.child_creation_time, true)) {
    return static_cast<int>(kStartupVerifyFailure);
  }

  const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[3];
  HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, job_name.c_str());
  if (job == nullptr) return static_cast<int>(kStartupVerifyFailure);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) {
    CloseHandle(job);
    return static_cast<int>(kStartupVerifyFailure);
  }
  BOOL is_member = FALSE;
  const BOOL queried = IsProcessInJob(process, job, &is_member);
  CloseHandle(process);
  CloseHandle(job);
  if (!queried || !is_member) return static_cast<int>(kStartupVerifyFailure);
  // Recheck the guardian after querying membership so exit during validation fails closed.
  return ProcessMatches(snapshot.guardian_pid, snapshot.guardian_creation_time, true)
             ? 0 : static_cast<int>(kStartupVerifyFailure);
}

bool IsSafeLockId(const wchar_t* value) {
  if (value == nullptr || *value == L'\0') return false;
  size_t length = 0;
  for (const wchar_t* p = value; *p != L'\0'; ++p) {
    if (++length > 64) return false;
    const wchar_t c = *p;
    if (!((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') ||
          (c >= L'0' && c <= L'9') || c == L'_' || c == L'-')) {
      return false;
    }
  }
  return true;
}

bool ParseProcessId(const wchar_t* value, DWORD* process_id) {
  if (value == nullptr || *value == L'\0') return false;
  DWORD parsed = 0;
  for (const wchar_t* p = value; *p != L'\0'; ++p) {
    if (*p < L'0' || *p > L'9') return false;
    const DWORD digit = static_cast<DWORD>(*p - L'0');
    if (parsed > (MAXDWORD - digit) / 10) return false;
    parsed = parsed * 10 + digit;
  }
  if (parsed == 0) return false;
  *process_id = parsed;
  return true;
}

std::wstring QuoteArgument(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return argument;
  }

  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t c : argument) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    if (c == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(c);
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(c);
    }
    backslashes = 0;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

std::wstring BuildCommandLine(int argc, wchar_t** argv, int child_start) {
  std::wstring result;
  for (int i = child_start; i < argc; ++i) {
    if (!result.empty()) result.push_back(L' ');
    result += QuoteArgument(argv[i]);
  }
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

bool CreateGenerationId(std::wstring* result) {
  HCRYPTPROV provider = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_FULL,
                            CRYPT_VERIFYCONTEXT | CRYPT_SILENT)) return false;
  unsigned char bytes[16]{};
  const BOOL generated = CryptGenRandom(provider, sizeof(bytes), bytes);
  CryptReleaseContext(provider, 0);
  if (!generated) return false;
  constexpr wchar_t hex[] = L"0123456789abcdef";
  result->clear();
  result->reserve(32);
  for (unsigned char byte : bytes) {
    result->push_back(hex[byte >> 4]);
    result->push_back(hex[byte & 0x0f]);
  }
  return true;
}

DWORD WaitForJobToBecomeEmpty(HANDLE job) {
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr)) {
      return GetLastError();
    }
    if (accounting.ActiveProcesses == 0) return ERROR_SUCCESS;
    Sleep(kPollMilliseconds);
  }
}

DWORD WaitForPreviousJobToBecomeEmpty(const std::wstring& job_name) {
  HANDLE previous_job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, job_name.c_str());
  if (previous_job == nullptr) {
    const DWORD error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : error;
  }

  const DWORD result = WaitForJobToBecomeEmpty(previous_job);
  CloseHandle(previous_job);
  return result;
}

int VerifyMember(int argc, wchar_t** argv) {
  DWORD process_id = 0;
  if (argc != 6 || wcscmp(argv[2], L"--lock-id") != 0 || !IsSafeLockId(argv[3]) ||
      wcscmp(argv[4], L"--pid") != 0 || !ParseProcessId(argv[5], &process_id)) {
    return static_cast<int>(kInvalidArgs);
  }

  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return static_cast<int>(kVerifyFailure);
  const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[3];
  HANDLE job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, job_name.c_str());
  if (job == nullptr) return static_cast<int>(kVerifyFailure);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (process == nullptr) {
    CloseHandle(job);
    return static_cast<int>(kVerifyFailure);
  }
  BOOL is_member = FALSE;
  const BOOL queried = IsProcessInJob(process, job, &is_member);
  CloseHandle(process);
  CloseHandle(job);
  if (!queried) return static_cast<int>(kVerifyFailure);
  return is_member ? 0 : static_cast<int>(kNotJobMember);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--verify-startup") == 0) {
    return VerifyStartup(argc, argv);
  }
  if (argc >= 2 && wcscmp(argv[1], L"--verify-member") == 0) {
    return VerifyMember(argc, argv);
  }
  if (argc < 5 || wcscmp(argv[1], L"--lock-id") != 0 ||
      !IsSafeLockId(argv[2]) || wcscmp(argv[3], L"--") != 0 ||
      argv[4][0] == L'\0') {
    return static_cast<int>(kInvalidArgs);
  }

  const std::wstring sid = CurrentUserSidString();
  if (sid.empty()) return static_cast<int>(kFailure);

  // The default DACL restricts the object to the current user's token. Including
  // the SID in the name makes the lock per-user across interactive sessions.
  const std::wstring mutex_name = L"Global\\ZeroGuardian_" + sid + L"_" + argv[2];
  const std::wstring job_name = L"Global\\ZeroGuardianJob_" + sid + L"_" + argv[2];
  SECURITY_ATTRIBUTES non_inheritable{};
  non_inheritable.nLength = sizeof(non_inheritable);
  non_inheritable.bInheritHandle = FALSE;
  SetLastError(ERROR_SUCCESS);
  HANDLE mutex = CreateMutexW(&non_inheritable, TRUE, mutex_name.c_str());
  if (mutex == nullptr) return static_cast<int>(kFailure);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    const DWORD wait = WaitForSingleObject(mutex, 0);
    if (wait == WAIT_TIMEOUT) {
      CloseHandle(mutex);
      return static_cast<int>(ERROR_ALREADY_EXISTS);
    }
    if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) {
      CloseHandle(mutex);
      return static_cast<int>(kFailure);
    }
  }

  // Do not open the previous Job until this process owns the mutex. Keeping an
  // old Job handle open before the old guardian exits suppresses last-handle
  // KILL_ON_JOB_CLOSE behavior.
  if (WaitForPreviousJobToBecomeEmpty(job_name) != ERROR_SUCCESS) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  // Local file mappings stay within this interactive session. The mutex and
  // Job remain global so they continue to serialize recovery across sessions.
  const std::wstring mapping_name = L"Local\\ZeroGuardianStartup_" + sid + L"_" + argv[2];
  StartupMapping startup_mapping;
  FILETIME guardian_creation_time{}, guardian_exit_time{}, guardian_kernel_time{},
      guardian_user_time{};
  if (!startup_mapping.Create(mapping_name) ||
      !GetProcessTimes(GetCurrentProcess(), &guardian_creation_time,
                       &guardian_exit_time, &guardian_kernel_time,
                       &guardian_user_time)) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  // These child variables describe the successful mutex + prior-Job check above.
  // They are lineage assertions, not a secret or proof against the same account.
  std::wstring generation;
  if (!CreateGenerationId(&generation) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_LOCK_ID", argv[2]) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_GENERATION", generation.c_str()) ||
      !SetEnvironmentVariableW(L"ZERO_GUARDIAN_PREDECESSOR_DRAINED", L"1")) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  SetLastError(ERROR_SUCCESS);
  HANDLE job = CreateJobObjectW(&non_inheritable, job_name.c_str());
  if (job == nullptr) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  std::wstring command_line = BuildCommandLine(argc, argv, 4);
  if (command_line.size() >= 32767) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kInvalidArgs);
  }
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(argv[4], mutable_command.data(), nullptr, nullptr, FALSE,
                      CREATE_SUSPENDED, nullptr, nullptr, &startup, &process)) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, kFailure);
    WaitForSingleObject(process.hProcess, INFINITE);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  FILETIME child_creation_time{}, child_exit_time{}, child_kernel_time{}, child_user_time{};
  if (!GetProcessTimes(process.hProcess, &child_creation_time, &child_exit_time,
                       &child_kernel_time, &child_user_time)) {
    TerminateJobObject(job, kFailure);
    WaitForSingleObject(process.hProcess, INFINITE);
    WaitForJobToBecomeEmpty(job);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }
  startup_mapping.Publish(generation, GetCurrentProcessId(), process.dwProcessId,
                          guardian_creation_time, child_creation_time);

  if (ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
    TerminateJobObject(job, kFailure);
    WaitForSingleObject(process.hProcess, INFINITE);
    WaitForJobToBecomeEmpty(job);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(kFailure);
  }

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD child_exit_code = kFailure;
  GetExitCodeProcess(process.hProcess, &child_exit_code);

  // The direct launcher can exit while descendants still run. Kill all remaining
  // members, then retain both handles until the Job reports no active processes.
  TerminateJobObject(job, child_exit_code);
  WaitForJobToBecomeEmpty(job);

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(job);
  ReleaseMutex(mutex);
  CloseHandle(mutex);
  return static_cast<int>(child_exit_code);
}
