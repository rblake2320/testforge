package com.example;

public interface Person {

    String getName();

    int getAge();

    String getEmail();

    default String getInfo() {
        return "Name: " + getName() + ", Age: " + getAge() + ", Email: " + getEmail();
    }
}
