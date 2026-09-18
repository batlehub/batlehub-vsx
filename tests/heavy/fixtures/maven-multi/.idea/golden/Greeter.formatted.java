package com.acme.core;

import java.util.ArrayList;
import java.util.List;

public class Greeter
{
  private final List<Person> people = new ArrayList<>();
  private int unused;

  public void add(Person p)
  {
    this.people.add(p);
  }

  public String all()
  {
    String out = "";
    for (Person p : people)
    {
      out = out + p.greeting() + "\n";
    }
    return out;
  }

  public boolean isEmpty()
  {
    return people.size() == 0;
  }
}
