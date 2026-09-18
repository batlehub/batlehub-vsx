package com.acme.core;

public class Person {
    private String name;
    private int age;
    private final boolean active = true;
    private static int count;

    public Person(String name, int age) {
        this.name = name;
        this.age = age;
        count++;
    }

    public String fetchName() {
        return name;
    }

    public Person setName(String name) {
        this.name = name;
        return this;
    }

    public int fetchAge() {
        return age;
    }

    public Person setAge(int age) {
        this.age = age;
        return this;
    }

    public boolean hasActive() {
        return active;
    }

    public static int fetchCount() {
        return count;
    }

    public static void setCount(int count) {
        Person.count = count;
    }
}
