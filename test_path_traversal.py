#!/usr/bin/env python3
"""Test path traversal fix for group-buying app"""

import requests
import subprocess
import time
import os

BASE_URL = "http://localhost:8080"

def test_request(path, expected_status, description):
    """Test a single request"""
    try:
        url = f"{BASE_URL}{path}"
        response = requests.get(url, timeout=5)
        actual_status = response.status_code
        passed = actual_status == expected_status
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status} - {description}")
        print(f"       URL: {url}")
        print(f"       Expected: {expected_status}, Got: {actual_status}")
        return passed
    except Exception as e:
        print(f"❌ ERROR - {description}: {str(e)[:50]}")
        return False

def main():
    print("=" * 60)
    print("Path Traversal Vulnerability Test")
    print("=" * 60)
    
    # Start the server in background
    print("\n🚀 Starting server...")
    os.chdir("/home/baill/.openclaw/workspace/group-buying")
    
    # Check if server is already running
    try:
        requests.get(f"{BASE_URL}/", timeout=2)
        print("Server is already running")
    except:
        print("Please start the server manually: node server.js")
        return
    
    print("\n🧪 Running tests...\n")
    
    tests = [
        # (path, expected_status, description)
        ("/", 200, "Root path should serve index.html"),
        ("/index.html", 200, "Direct index.html access"),
        ("/app.js", 200, "App.js file access"),
        ("/styles.css", 200, "CSS file access"),
        
        # Path traversal attempts - should all be blocked (403)
        ("/../package.json", 403, "Basic path traversal (../)"),
        ("/..%2fpackage.json", 403, "URL encoded path traversal"),
        ("/....//package.json", 403, "Double dot path traversal"),
        ("/../server.js", 403, "Access server.js via traversal"),
        ("/../../etc/passwd", 403, "System file access attempt"),
        ("/data/../server.js", 403, "Traversal within allowed dir"),
        
        # Null byte injection - should be blocked
        ("/index.html%00.txt", 403, "Null byte injection"),
        
        # Absolute paths - should be blocked
        ("/etc/passwd", 403, "Absolute path to system file"),
        ("/root/.bashrc", 403, "Absolute path to root file"),
        
        # Non-existent files - should be 404 not 403
        ("/nonexistent-file-12345.js", 404, "Non-existent file"),
    ]
    
    passed = 0
    failed = 0
    
    for path, expected_status, description in tests:
        if test_request(path, expected_status, description):
            passed += 1
        else:
            failed += 1
        print()
    
    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 60)
    
    if failed == 0:
        print("\n🎉 All tests passed! Path traversal vulnerability is fixed.")
    else:
        print(f"\n⚠️  {failed} test(s) failed. Review the output above.")
    
    return failed == 0

if __name__ == "__main__":
    main()
